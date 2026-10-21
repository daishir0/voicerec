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
  private var routeObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("VoicerecAudio")

    Events("onAudioInterruption", "onAudioRouteChange")

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

    // ── 4. 端末内で文字起こしする ────────────────────────
    // iOS 26+ は SpeechAnalyzer（長時間向け・モデルは OS が持つ）。
    // それ以前は SFSpeechRecognizer を 55 秒ずつに切って回す（1セッション1分の上限）。
    AsyncFunction("transcribe") { (uri: String, locale: String, engine: String) -> [String: Any] in
      let began = Date()
      let url = Self.fileURL(uri)
      let loc = Locale(identifier: locale)

      if engine != "sf", #available(iOS 26.0, *) {
        do {
          let text = try await Self.transcribeWithAnalyzer(url: url, locale: loc)
          return ["text": text, "engine": "analyzer", "chunks": 1,
                  "elapsedMs": Int(Date().timeIntervalSince(began) * 1000)]
        } catch {
          if engine == "analyzer" { throw error }
          // 自動なら黙って旧APIに落ちる。理由は返して分かるようにしておく
          let (text, chunks) = try await Self.transcribeWithSF(url: url, locale: loc)
          return ["text": text, "engine": "sf", "chunks": chunks,
                  "fallbackReason": error.localizedDescription,
                  "elapsedMs": Int(Date().timeIntervalSince(began) * 1000)]
        }
      }
      let (text, chunks) = try await Self.transcribeWithSF(url: url, locale: loc)
      return ["text": text, "engine": "sf", "chunks": chunks,
              "elapsedMs": Int(Date().timeIntervalSince(began) * 1000)]
    }

    /// 言語モデルを先に入れておく（初回だけ時間がかかるので、設定で言語を変えた直後に呼ぶ）
    AsyncFunction("prepareLocale") { (locale: String) -> [String: Any] in
      if #available(iOS 26.0, *) {
        let loc = Locale(identifier: locale)
        let supported = await SpeechTranscriber.supportedLocales
        guard supported.contains(where: { $0.identifier(.bcp47) == loc.identifier(.bcp47) }) else {
          return ["installed": false, "reason": "この言語は端末内の音声認識に対応していません"]
        }
        let installed = await SpeechTranscriber.installedLocales
        if installed.contains(where: { $0.identifier(.bcp47) == loc.identifier(.bcp47) }) {
          return ["installed": true, "downloaded": false]
        }
        let t = SpeechTranscriber(locale: loc, transcriptionOptions: [],
                                  reportingOptions: [], attributeOptions: [])
        if let req = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
          try await req.downloadAndInstall()
        }
        return ["installed": true, "downloaded": true]
      }
      return ["installed": false, "reason": "iOS 26 以降が必要です"]
    }

    // ── 5. 録音の中断を検知する ──────────────────────────
    // 8時間録っていれば着信は必ず当たる。黙って止まるのが最悪なので拾って知らせる。
    /// いま録音に使っている入力。Bluetooth に取られると音質が大きく落ちるので、
    /// 画面に出して気づけるようにする。
    Function("currentInput") { () -> [String: Any] in
      let s = AVAudioSession.sharedInstance()
      let input = s.currentRoute.inputs.first
      return [
        "name": input?.portName ?? "",
        "type": input?.portType.rawValue ?? "",
        "isBluetooth": Self.isBluetooth(input?.portType),
        "sampleRate": s.sampleRate,
      ]
    }

    Function("startInterruptionObserver") { () -> Bool in
      if self.routeObserver == nil {
        // ⚠️ イヤホンや Bluetooth を抜き差しすると入力が変わり、サンプルレートまで変わる。
        //    録音中に変わると、そのままでは1本のファイルの途中で形式が変わってしまう。
        self.routeObserver = NotificationCenter.default.addObserver(
          forName: AVAudioSession.routeChangeNotification,
          object: AVAudioSession.sharedInstance(), queue: .main
        ) { [weak self] note in
          let s = AVAudioSession.sharedInstance()
          let input = s.currentRoute.inputs.first
          var payload: [String: Any] = [
            "inputName": input?.portName ?? "",
            "inputType": input?.portType.rawValue ?? "",
            "isBluetooth": Self.isBluetooth(input?.portType),
            "sampleRate": s.sampleRate,
          ]
          if let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
             let reason = AVAudioSession.RouteChangeReason(rawValue: raw) {
            payload["reason"] = Self.routeReasonString(reason)
            // 入力そのものが変わったときだけ、呼び出し側に録り直しを促す
            payload["inputChanged"] = (reason == .newDeviceAvailable
                                       || reason == .oldDeviceUnavailable
                                       || reason == .override
                                       || reason == .routeConfigurationChange)
          } else {
            payload["reason"] = "unknown"
            payload["inputChanged"] = false
          }
          self?.sendEvent("onAudioRouteChange", payload)
        }
      }
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
      if let o = self.routeObserver {
        NotificationCenter.default.removeObserver(o)
        self.routeObserver = nil
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

  private static func isBluetooth(_ type: AVAudioSession.Port?) -> Bool {
    guard let type = type else { return false }
    return type == .bluetoothHFP || type == .bluetoothA2DP || type == .bluetoothLE
  }

  private static func routeReasonString(_ r: AVAudioSession.RouteChangeReason) -> String {
    switch r {
    case .newDeviceAvailable: return "newDeviceAvailable"
    case .oldDeviceUnavailable: return "oldDeviceUnavailable"
    case .categoryChange: return "categoryChange"
    case .override: return "override"
    case .wakeFromSleep: return "wakeFromSleep"
    case .noSuitableRouteForCategory: return "noSuitableRouteForCategory"
    case .routeConfigurationChange: return "routeConfigurationChange"
    case .unknown: return "unknown"
    @unknown default: return "unknown"
    }
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

  /// iOS 26+ の SpeechAnalyzer。長時間の音声をそのまま渡せる。
  ///
  /// ⚠️ reportingOptions を空にしてある。途中経過（volatile）を出さない設定なので、
  ///    返ってくる結果はすべて確定で、そのまま連結してよい。
  /// ⚠️ finalizeAndFinishThroughEndOfInput() を呼ばないと results の for-await が終わらない。
  @available(iOS 26.0, *)
  private static func transcribeWithAnalyzer(url: URL, locale: Locale) async throws -> String {
    let supported = await SpeechTranscriber.supportedLocales
    guard supported.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else {
      throw Exception(name: "LocaleNotSupported",
                      description: "\(locale.identifier) は端末内の音声認識に対応していません")
    }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [],
                                        reportingOptions: [], attributeOptions: [])
    let installed = await SpeechTranscriber.installedLocales
    if !installed.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) {
      if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await req.downloadAndInstall()
      }
    }

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let file = try AVAudioFile(forReading: url)

    // 読み出しは音声を流し込むのと同時に回す（先に finalize すると取りこぼす）
    let collect = Task { () -> String in
      var out = ""
      for try await result in transcriber.results {
        out += String(result.text.characters)
      }
      return out
    }
    try await analyzer.analyzeSequence(from: file)
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    return try await collect.value
  }

  /// SFSpeechRecognizer。1セッション1分の上限があるので 55 秒ずつに切って回す。
  private static func transcribeWithSF(url: URL, locale: Locale) async throws -> (String, Int) {
    guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
      throw Exception(name: "RecognizerUnavailable",
                      description: "\(locale.identifier) の音声認識が使えません")
    }
    recognizer.defaultTaskHint = .dictation

    let asset = AVURLAsset(url: url)
    let total = CMTimeGetSeconds(try await asset.load(.duration))
    guard total > 0 else {
      throw Exception(name: "EmptyAudio", description: "長さが分かりません（録音中のファイル？）")
    }

    let chunk = 55.0
    var texts: [String] = []
    var at = 0.0
    let tmpDir = FileManager.default.temporaryDirectory
    while at < total {
      let to = min(at + chunk, total)
      let part = tmpDir.appendingPathComponent("sfchunk-\(UUID().uuidString).wav")
      _ = try await transcode(src: url, dst: part, startSec: at, endSec: to,
                              fileType: .wav, settings: pcmSettings)
      defer { try? FileManager.default.removeItem(at: part) }
      texts.append(try await recognizeOne(recognizer: recognizer, url: part))
      at = to
    }
    return (texts.joined(separator: ""), texts.count)
  }

  private static func recognizeOne(recognizer: SFSpeechRecognizer, url: URL) async throws -> String {
    try await withCheckedThrowingContinuation { cont in
      let request = SFSpeechURLRecognitionRequest(url: url)
      request.shouldReportPartialResults = false
      // 端末内で処理する。できない端末ではサーバーに送られるので、使えるときだけ立てる
      if recognizer.supportsOnDeviceRecognition {
        request.requiresOnDeviceRecognition = true
      }
      var resumed = false
      recognizer.recognitionTask(with: request) { result, error in
        if resumed { return }
        if let error = error {
          resumed = true
          cont.resume(throwing: error)
          return
        }
        if let result = result, result.isFinal {
          resumed = true
          cont.resume(returning: result.bestTranscription.formattedString)
        }
      }
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
    // ⚠️ **録音中のファイルは長さが 0 と返る**（CAF は読めるのに duration は未確定）。
    //    ここで total で丸めると、呼び出し側が正しい範囲を渡しても「範囲が空」で弾いてしまう。
    //    2026-10-21、録音中の切り出しが試せたはずなのに、この行のせいで検証が無効になった。
    //    長さが分からないときは、頼まれた範囲をそのまま読みに行って、取れた分を返す。
    let totalRaw = CMTimeGetSeconds(try await asset.load(.duration))
    let total = totalRaw.isFinite && totalRaw > 0 ? totalRaw : 0
    let from = max(0, startSec)
    let to = total > 0 ? min(endSec > 0 ? endSec : total, total) : max(endSec, from)
    guard to > from else {
      throw Exception(name: "EmptyRange",
                      description: "範囲が空です (\(from) → \(to), 全体 \(total)秒)")
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
    // 書けた実際の長さ。録音中のファイルからだと、頼んだ範囲より短くなることがある
    let wrote = CMTimeGetSeconds(try await AVURLAsset(url: dst).load(.duration))
    return [
      "uri": dst.path,
      "fileSize": size,
      "startSec": from,
      "endSec": to,
      "durationSec": wrote.isFinite && wrote > 0 ? wrote : to - from,
      "requestedSec": to - from,
      "elapsedMs": Int(Date().timeIntervalSince(began) * 1000)
    ]
  }
}
