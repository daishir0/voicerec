// voicerec のネイティブ処理。
//
// ここに集約するもの:
//   1. 録音中のファイルを「いま読めるか」を確かめる（inspect）
//   2. 指定した時間の範囲を切り出す（trimToWav / trimToM4a）
//   3. 端末内の音声認識が使えるかを調べる（probe）
//   4. 録音の中断（着信・他アプリのマイク奪取）を検知して JS に伝える
//
// ⚠️ EC2 ではコンパイルできない。Mac でのビルドが唯一の検証手段なので、
//    推測で API を使わず、失敗したらログを読んで直す。

import AVFoundation
import ExpoModulesCore
import Speech

public class VoicerecAudioModule: Module {
  private var interruptionObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("VoicerecAudio")

    Events("onAudioInterruption")

    // ── 1. 端末内音声認識の可否 ──────────────────────────
    AsyncFunction("probe") { (locale: String) -> [String: Any] in
      var out: [String: Any] = [
        "osVersion": UIDevice.current.systemVersion
      ]

      // SFSpeechRecognizer（iOS 13+）。1セッション1分の上限があるので長時間には分割が要る。
      let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
      out["sfSupported"] = recognizer != nil
      out["sfAvailable"] = recognizer?.isAvailable ?? false
      out["sfOnDevice"] = recognizer?.supportsOnDeviceRecognition ?? false
      out["sfAuthStatus"] = Self.authString(SFSpeechRecognizer.authorizationStatus())

      // SpeechAnalyzer / SpeechTranscriber（iOS 26+）。長時間・オンデバイス向け。
      if #available(iOS 26.0, *) {
        let supported = await SpeechTranscriber.supportedLocales
        let installed = await SpeechTranscriber.installedLocales
        out["analyzerAvailable"] = true
        out["analyzerLocales"] = supported.map { $0.identifier(.bcp47) }
        out["analyzerInstalled"] = installed.map { $0.identifier(.bcp47) }
        out["analyzerSupportsLocale"] = supported.contains {
          $0.identifier(.bcp47).lowercased().hasPrefix(locale.prefix(2).lowercased())
        }
      } else {
        out["analyzerAvailable"] = false
        out["analyzerLocales"] = [String]()
        out["analyzerInstalled"] = [String]()
        out["analyzerSupportsLocale"] = false
      }
      return out
    }

    AsyncFunction("requestSpeechPermission") { () -> String in
      await withCheckedContinuation { cont in
        SFSpeechRecognizer.requestAuthorization { status in
          cont.resume(returning: Self.authString(status))
        }
      }
    }

    // ── 2. 録音中のファイルが読めるか ────────────────────
    // m4a は停止時にしか索引(moov)を書かないので、録音中は読めず、
    // クラッシュするとファイルごと失われる。caf なら読めるはず、を実機で確かめる。
    AsyncFunction("inspect") { (uri: String) -> [String: Any] in
      let url = Self.fileURL(uri)
      var out: [String: Any] = ["uri": url.path]
      let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
      out["fileSize"] = (attrs?[.size] as? NSNumber)?.intValue ?? 0

      let asset = AVURLAsset(url: url)
      do {
        let duration = try await asset.load(.duration)
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        out["readable"] = duration.isNumeric && !tracks.isEmpty
        out["durationSec"] = duration.isNumeric ? CMTimeGetSeconds(duration) : 0
        out["trackCount"] = tracks.count
        if let t = tracks.first {
          let descs = try await t.load(.formatDescriptions)
          if let d = descs.first,
             let basic = CMAudioFormatDescriptionGetStreamBasicDescription(d)?.pointee {
            out["sampleRate"] = basic.mSampleRate
            out["channels"] = Int(basic.mChannelsPerFrame)
            out["formatID"] = Self.fourCC(basic.mFormatID)
          }
        }
      } catch {
        out["readable"] = false
        out["error"] = error.localizedDescription
      }
      return out
    }

    // ── 3. 範囲の切り出し ────────────────────────────────
    // 16kHz モノラル WAV にする。音声認識はどちらのエンジンもこの形を好む。
    AsyncFunction("trimToWav") { (uri: String, startSec: Double, endSec: Double, outUri: String) -> [String: Any] in
      try await Self.transcode(src: Self.fileURL(uri), dst: Self.fileURL(outUri),
                               startSec: startSec, endSec: endSec, fileType: .wav,
                               settings: Self.pcmSettings)
    }

    // アップロード用。サーバーは m4a を受け取る。
    AsyncFunction("trimToM4a") { (uri: String, startSec: Double, endSec: Double, outUri: String) -> [String: Any] in
      try await Self.transcode(src: Self.fileURL(uri), dst: Self.fileURL(outUri),
                               startSec: startSec, endSec: endSec, fileType: .m4a,
                               settings: Self.aacSettings)
    }

    // ── 4. 録音の中断を検知する ──────────────────────────
    // 8時間録っていれば着信は必ず当たる。黙って止まるのが最悪なので拾って知らせる。
    Function("startInterruptionObserver") { () -> Bool in
      if self.interruptionObserver != nil { return true }
      self.interruptionObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: AVAudioSession.sharedInstance(), queue: .main
      ) { [weak self] note in
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        var payload: [String: Any] = ["type": type == .began ? "began" : "ended"]
        if let reason = info[AVAudioSessionInterruptionReasonKey] as? UInt {
          payload["reason"] = reason
        }
        if type == .ended, let opts = info[AVAudioSessionInterruptionOptionKey] as? UInt {
          payload["shouldResume"] = AVAudioSession.InterruptionOptions(rawValue: opts).contains(.shouldResume)
        }
        self?.sendEvent("onAudioInterruption", payload)
      }
      return true
    }

    Function("stopInterruptionObserver") { () -> Bool in
      if let o = self.interruptionObserver {
        NotificationCenter.default.removeObserver(o)
        self.interruptionObserver = nil
      }
      return true
    }
  }

  // ── 補助 ───────────────────────────────────────────────
  private static let pcmSettings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVSampleRateKey: 16000,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false
  ]

  private static let aacSettings: [String: Any] = [
    AVFormatIDKey: kAudioFormatMPEG4AAC,
    AVSampleRateKey: 16000,
    AVNumberOfChannelsKey: 1,
    AVEncoderBitRateKey: 32000
  ]

  private static func fileURL(_ uri: String) -> URL {
    if uri.hasPrefix("file://") { return URL(string: uri) ?? URL(fileURLWithPath: uri) }
    return URL(fileURLWithPath: uri)
  }

  private static func fourCC(_ id: AudioFormatID) -> String {
    let bytes = [UInt8((id >> 24) & 0xFF), UInt8((id >> 16) & 0xFF),
                 UInt8((id >> 8) & 0xFF), UInt8(id & 0xFF)]
    return String(bytes: bytes, encoding: .ascii) ?? "?"
  }

  private static func authString(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch s {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
  }

  /// 指定範囲を読み出して書き直す。AVAssetExportSession ではサンプルレートを
  /// 指定できないので、reader/writer で自分で回す。
  private static func transcode(src: URL, dst: URL, startSec: Double, endSec: Double,
                                fileType: AVFileType, settings: [String: Any]) async throws -> [String: Any] {
    let began = Date()
    let asset = AVURLAsset(url: src)
    let tracks = try await asset.loadTracks(withMediaType: .audio)
    guard let track = tracks.first else {
      throw Exception(name: "NoAudioTrack", description: "音声トラックがありません: \(src.lastPathComponent)")
    }
    let total = CMTimeGetSeconds(try await asset.load(.duration))
    let from = max(0, startSec)
    let to = min(endSec > 0 ? endSec : total, total)
    guard to > from else {
      throw Exception(name: "EmptyRange", description: "範囲が空です (\(from) → \(to), 全体 \(total)秒)")
    }

    let reader = try AVAssetReader(asset: asset)
    reader.timeRange = CMTimeRange(
      start: CMTime(seconds: from, preferredTimescale: 600),
      end: CMTime(seconds: to, preferredTimescale: 600))
    // 読み出しは必ずリニアPCMに展開する（圧縮のままでは書き手に渡せない）
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: pcmSettings)
    output.alwaysCopiesSampleData = false
    reader.add(output)

    try? FileManager.default.removeItem(at: dst)
    try FileManager.default.createDirectory(at: dst.deletingLastPathComponent(),
                                            withIntermediateDirectories: true)
    let writer = try AVAssetWriter(outputURL: dst, fileType: fileType)
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    writer.add(input)

    guard writer.startWriting() else {
      throw Exception(name: "WriterFailed",
                      description: writer.error?.localizedDescription ?? "startWriting に失敗")
    }
    writer.startSession(atSourceTime: .zero)
    guard reader.startReading() else {
      throw Exception(name: "ReaderFailed",
                      description: reader.error?.localizedDescription ?? "startReading に失敗")
    }

    let queue = DispatchQueue(label: "jp.path-finder.voicerec.transcode")
    await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
      input.requestMediaDataWhenReady(on: queue) {
        while input.isReadyForMoreMediaData {
          guard reader.status == .reading, let buf = output.copyNextSampleBuffer() else {
            input.markAsFinished()
            writer.finishWriting { cont.resume() }
            return
          }
          if !input.append(buf) {
            reader.cancelReading()
            input.markAsFinished()
            writer.finishWriting { cont.resume() }
            return
          }
        }
      }
    }

    if writer.status != .completed {
      throw Exception(name: "TranscodeFailed",
                      description: writer.error?.localizedDescription ?? "書き出しが完了しませんでした")
    }
    let size = (try? FileManager.default.attributesOfItem(atPath: dst.path)[.size] as? NSNumber)??.intValue ?? 0
    return [
      "uri": dst.path,
      "fileSize": size,
      "startSec": from,
      "endSec": to,
      "durationSec": to - from,
      "elapsedMs": Int(Date().timeIntervalSince(began) * 1000)
    ]
  }
}
