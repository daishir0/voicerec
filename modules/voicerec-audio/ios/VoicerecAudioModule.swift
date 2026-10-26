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
      // settings を渡さない＝元の音声と同じ形で書く
      try await Self.transcode(src: Self.fileURL(uri), dst: Self.fileURL(outUri),
                               startSec: startSec, endSec: endSec, fileType: .m4a,
                               settings: nil)
    }

    // ── 複数のファイルをまたいで切り出す ────────────────
    // 「ここまでを確定する」で録音を区切ると、1回の録音が2つ以上のファイルに分かれる。
    // 利用者にとっては1本の録音なので、ファイルの境目をまたぐ範囲も選べなければならない。
    // AVMutableComposition に順番に差し込めば、1本の音声として読み出せる。
    //
    // ⚠️ 引数は**平行な配列**で受ける。辞書の配列は Expo Modules の変換に依存するので、
    //    実機でしか試せない場所で冒険しない。
    AsyncFunction("clipRangesToWav") { (uris: [String], starts: [Double], ends: [Double], outUri: String) -> [String: Any] in
      try await Self.transcodeMany(uris: uris, starts: starts, ends: ends,
                                   dst: Self.fileURL(outUri), fileType: .wav,
                                   settings: Self.pcmSettings)
    }

    AsyncFunction("clipRangesToM4a") { (uris: [String], starts: [Double], ends: [Double], outUri: String) -> [String: Any] in
      try await Self.transcodeMany(uris: uris, starts: starts, ends: ends,
                                   dst: Self.fileURL(outUri), fileType: .m4a,
                                   settings: nil)
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
          let segs = try await Self.transcribeWithAnalyzer(url: url, locale: loc)
          return ["text": Self.joined(segs), "segments": Self.dicts(segs),
                  "engine": "analyzer", "chunks": 1,
                  "elapsedMs": Int(Date().timeIntervalSince(began) * 1000)]
        } catch {
          if engine == "analyzer" { throw error }
          // 自動なら旧APIに落ちる。落ちた理由は必ず返す（黙って落ちると原因が消える）
          let why = Self.describe(error, where: "SpeechAnalyzer")
          let (segs, chunks) = try await Self.transcribeWithSF(url: url, locale: loc)
          return ["text": Self.joined(segs), "segments": Self.dicts(segs),
                  "engine": "sf", "chunks": chunks, "fallbackReason": why,
                  "elapsedMs": Int(Date().timeIntervalSince(began) * 1000)]
        }
      }
      let (segs, chunks) = try await Self.transcribeWithSF(url: url, locale: loc)
      return ["text": Self.joined(segs), "segments": Self.dicts(segs),
              "engine": "sf", "chunks": chunks,
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
        "uid": input?.uid ?? "",
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
            "inputUID": input?.uid ?? "",
            "isBluetooth": Self.isBluetooth(input?.portType),
            "sampleRate": s.sampleRate,
          ]
          if let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
             let reason = AVAudioSession.RouteChangeReason(rawValue: raw) {
            payload["reason"] = Self.routeReasonString(reason)
            // ⚠️ **機器が抜き差しされたときだけ**を「入力が変わった」とみなす。
            //    routeConfigurationChange は録音を始めただけでも飛んでくるので、
            //    これを入れると「区切る→録り直す→また飛ぶ」で無限に回る
            //    （2026-10-21、32ms のファイルが大量に作られた）。
            payload["inputChanged"] = (reason == .newDeviceAvailable
                                       || reason == .oldDeviceUnavailable)
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

  /// 文字起こしの一区切り。音声のどこを読んだかを持つ。
  struct Seg {
    let text: String
    let start: Double
    let end: Double
  }

  private static func joined(_ segs: [Seg]) -> String {
    segs.map { $0.text }.joined()
  }

  private static func dicts(_ segs: [Seg]) -> [[String: Any]] {
    segs.map { ["text": $0.text, "startSec": $0.start, "endSec": $0.end] }
  }
  private static let pcmSettings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVSampleRateKey: 16000,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false
  ]

  /// 元の音声が分からないときに使う AAC の設定
  private static let aacSettingsDefault: [String: Any] = [
    AVFormatIDKey: kAudioFormatMPEG4AAC,
    AVSampleRateKey: 16000,
    AVNumberOfChannelsKey: 1,
    AVEncoderBitRateKey: 32000
  ]

  /// AAC で選べるビットレート。実測値をこの中の一番近いものに寄せる
  private static let aacBitRateChoices = [12000, 16000, 24000, 32000, 48000, 64000]
  /// これ以上は上げない。文字起こしのための録音に高音質は要らない
  private static let aacBitRateCap = 64000

  /// 元の音声と同じ形で書き出すための設定を作る。
  ///
  /// ⚠️ 固定で 16kHz / 32kbps を書いていたため、12kHz / 16kbps で録った音声を
  /// 切り出すと**サイズが2倍**になっていた（2026-10-26、8時間の録音が 54.9MB → 108.2MB）。
  /// AAC が一度捨てた情報はビットレートを上げても戻らないので、増えるのは容量だけで、
  /// 音質は元のまま。アップロード量も保存容量も無駄に倍になる。
  /// 切り出しは「範囲を切り取る」操作であって、品質を変える操作ではない。
  private static func aacSettingsMatching(_ track: AVAssetTrack, asset: AVAsset, url: URL)
    async -> (settings: [String: Any], measuredBps: Int, how: String) {
    var sampleRate = 16000.0
    var channels = 1
    if let fds = try? await track.load(.formatDescriptions),
       let asbd = fds.first.flatMap({ CMAudioFormatDescriptionGetStreamBasicDescription($0) })?.pointee {
      if asbd.mSampleRate > 0 { sampleRate = asbd.mSampleRate }
      if asbd.mChannelsPerFrame > 0 { channels = Int(asbd.mChannelsPerFrame) }
    }

    // ⚠️ 切り出しタブの録音は **.caf** で、AVFoundation はこの形式に対して
    //    estimatedDataRate も totalSampleDataLength も **0 を返す**（2026-10-26 に両方とも踏んだ）。
    //    トラックに聞くのはやめて、最後はファイルそのものの大きさから割り出す。
    //    容器のヘッダぶん少し多めに出るが、選べる値に寄せるので結果は変わらない。
    var bytes: Int64 = 0
    var how = "none"
    if let n = try? await track.load(.totalSampleDataLength), n > 0 {
      bytes = n
      how = "track"
    } else if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let n = (attrs[.size] as? NSNumber)?.int64Value, n > 0 {
      bytes = n
      how = "file"
    }

    var sec = 0.0
    if let r = try? await track.load(.timeRange) { sec = CMTimeGetSeconds(r.duration) }
    if !(sec > 0 && sec.isFinite), let d = try? await asset.load(.duration) {
      sec = CMTimeGetSeconds(d)
    }

    var measured = 0.0
    if bytes > 0, sec > 0, sec.isFinite {
      measured = Double(bytes) * 8 / sec
    } else if let rate = try? await track.load(.estimatedDataRate), rate.isFinite, rate > 0 {
      measured = Double(rate)
      how = "estimate"
    } else {
      how = "none"
    }

    var bitRate = 32000
    if measured > 0 {
      let want = Int(measured)
      // 実測は 17,938 のような半端な値になるので、選べる値の中で一番近いものにする
      bitRate = aacBitRateChoices.min(by: { abs($0 - want) < abs($1 - want) }) ?? 32000
    }
    bitRate = min(bitRate, aacBitRateCap)

    return ([
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: sampleRate,
      AVNumberOfChannelsKey: channels,
      AVEncoderBitRateKey: bitRate
    ], Int(measured), how)
  }

  private static func fileURL(_ uri: String) -> URL {
    if uri.hasPrefix("file://") { return URL(string: uri) ?? URL(fileURLWithPath: uri) }
    return URL(fileURLWithPath: uri)
  }

  private static func fourCC(_ id: AudioFormatID) -> String {
    let bytes = [UInt8((id >> 24) & 0xFF), UInt8((id >> 16) & 0xFF),
                 UInt8((id >> 8) & 0xFF), UInt8(id & 0xFF)]
    return String(bytes: bytes, encoding: .ascii) ?? "?"
  }

  /// どこで落ちたかの印を付けて投げ直す。
  ///
  /// ⚠️ 印の無い NSError は localizedDescription が
  ///    「The operation could not be completed」にしかならず、原因の手がかりが消える。
  ///    AVFoundation を呼ぶところは**必ず**これで包む（2026-10-23、これが無くて3往復した）。
  fileprivate static func step<T>(_ what: String, _ body: () throws -> T) throws -> T {
    do { return try body() } catch {
      throw Exception(name: "StepFailed", description: describeStatic(error, where: what))
    }
  }

  fileprivate static func step<T>(_ what: String, _ body: () async throws -> T) async throws -> T {
    do { return try await body() } catch {
      throw Exception(name: "StepFailed", description: describeStatic(error, where: what))
    }
  }

  /// エラーを追える文言にする。NSError の domain と code まで出す。
  fileprivate static func describeStatic(_ error: Error?, where what: String) -> String {
    describe(error, where: what)
  }

  private static func describe(_ error: Error?, where what: String) -> String {
    guard let e = error as NSError? else { return "\(what)に失敗しました（詳細不明）" }
    var s = "\(what)に失敗: \(e.localizedDescription) [\(e.domain) \(e.code)]"
    if let under = e.userInfo[NSUnderlyingErrorKey] as? NSError {
      s += " ← \(under.localizedDescription) [\(under.domain) \(under.code)]"
    }
    return s
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
  private static func transcribeWithAnalyzer(url: URL, locale: Locale) async throws -> [Seg] {
    let supported = await SpeechTranscriber.supportedLocales
    guard supported.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else {
      throw Exception(name: "LocaleNotSupported",
                      description: "\(locale.identifier) は端末内の音声認識に対応していません")
    }
    // ⚠️ .audioTimeRange を頼まないと、どこを読んだ文字なのかが返ってこない。
    //    「全部文字になっているか」を利用者が確かめられるように、必ず付ける。
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [],
                                        reportingOptions: [],
                                        attributeOptions: [.audioTimeRange])
    let installed = await SpeechTranscriber.installedLocales
    if !installed.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) {
      try await Self.step("\(locale.identifier) の音声認識モデルの用意", {
        if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
          try await req.downloadAndInstall()
        }
      })
    }

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let file: AVAudioFile
    do {
      file = try AVAudioFile(forReading: url)
    } catch {
      throw Exception(name: "OpenFailed",
                      description: Self.describeStatic(error, where: "音声ファイルを開く \(url.lastPathComponent)"))
    }

    // 読み出しは音声を流し込むのと同時に回す（先に finalize すると取りこぼす）
    let collect = Task { () -> [Seg] in
      var out: [Seg] = []
      for try await result in transcriber.results {
        let attributed = result.text
        // 位置の情報は属性として付いてくる。付いていない部分は直前の続きとして扱う
        for run in attributed.runs {
          let piece = String(attributed[run.range].characters)
          if piece.isEmpty { continue }
          if let r = run.audioTimeRange {
            out.append(Seg(text: piece,
                           start: CMTimeGetSeconds(r.start),
                           end: CMTimeGetSeconds(CMTimeRangeGetEnd(r))))
          } else if var last = out.popLast() {
            last = Seg(text: last.text + piece, start: last.start, end: last.end)
            out.append(last)
          } else {
            out.append(Seg(text: piece, start: 0, end: 0))
          }
        }
      }
      return out
    }
    try await Self.step("音声の解析", { try await analyzer.analyzeSequence(from: file) })
    try await Self.step("解析の終了処理", { try await analyzer.finalizeAndFinishThroughEndOfInput() })
    return try await Self.step("解析結果の取り出し", { try await collect.value })
  }

  /// SFSpeechRecognizer。1セッション1分の上限があるので 55 秒ずつに切って回す。
  private static func transcribeWithSF(url: URL, locale: Locale) async throws -> ([Seg], Int) {
    guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
      throw Exception(name: "RecognizerUnavailable",
                      description: "\(locale.identifier) の音声認識が使えません")
    }
    recognizer.defaultTaskHint = .dictation

    let asset = AVURLAsset(url: url)
    let total = CMTimeGetSeconds(try await Self.step("長さの取得（分割用）", {
      try await asset.load(.duration)
    }))
    guard total > 0 else {
      throw Exception(name: "EmptyAudio", description: "長さが分かりません（録音中のファイル？）")
    }

    let chunk = 55.0
    var segs: [Seg] = []
    var at = 0.0
    let tmpDir = FileManager.default.temporaryDirectory
    while at < total {
      let to = min(at + chunk, total)
      let part = tmpDir.appendingPathComponent("sfchunk-\(UUID().uuidString).wav")
      _ = try await transcode(src: url, dst: part, startSec: at, endSec: to,
                              fileType: .wav, settings: pcmSettings)
      defer { try? FileManager.default.removeItem(at: part) }
      // 分割した位置ぶんだけ、時刻をずらして足す
      let offset = at
      segs += try await recognizeOne(recognizer: recognizer, url: part)
        .map { Seg(text: $0.text, start: $0.start + offset, end: $0.end + offset) }
      at = to
    }
    return (segs, Int(ceil(total / chunk)))
  }

  private static func recognizeOne(recognizer: SFSpeechRecognizer, url: URL) async throws -> [Seg] {
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
          cont.resume(throwing: Exception(
            name: "RecognizeFailed",
            description: Self.describeStatic(error, where: "音声認識 \(url.lastPathComponent)")))
          return
        }
        if let result = result, result.isFinal {
          resumed = true
          // SFSpeech は元から区間ごとの時刻を持っている
          cont.resume(returning: result.bestTranscription.segments.map {
            Seg(text: $0.substring, start: $0.timestamp, end: $0.timestamp + $0.duration)
          })
        }
      }
    }
  }

  /// 複数のファイルの一部ずつを、時間順に繋いで1本に書き出す。
  ///
  /// 録音を区切ると1回の録音が複数ファイルになるが、利用者にとっては1本なので、
  /// 境目をまたぐ範囲も扱えなければならない。
  private static func transcodeMany(uris: [String], starts: [Double], ends: [Double],
                                    dst: URL, fileType: AVFileType,
                                    settings: [String: Any]?) async throws -> [String: Any] {
    let began = Date()
    guard uris.count == starts.count, uris.count == ends.count, !uris.isEmpty else {
      throw Exception(name: "BadArguments",
                      description: "uris/starts/ends の数が合いません (\(uris.count)/\(starts.count)/\(ends.count))")
    }

    let comp = AVMutableComposition()
    guard let compTrack = comp.addMutableTrack(withMediaType: .audio,
                                               preferredTrackID: kCMPersistentTrackID_Invalid) else {
      throw Exception(name: "CompositionFailed", description: "合成用のトラックを作れません")
    }

    var cursor = CMTime.zero
    var used = 0
    // 書き出しの設定を作るために、最初に読めた元ファイルを覚えておく
    var firstSourceTrack: AVAssetTrack?
    var firstSourceAsset: AVAsset?
    var firstSourceURL: URL?
    for i in 0..<uris.count {
      let url = fileURL(uris[i])
      let asset = AVURLAsset(url: url)
      let name = url.lastPathComponent
      guard let track = try await Self.step("\(name) のトラック読み込み", {
        try await asset.loadTracks(withMediaType: .audio).first
      }) else { continue }
      if firstSourceTrack == nil {
        firstSourceTrack = track
        firstSourceAsset = asset
        firstSourceURL = url
      }
      let from = max(0, starts[i])
      let to = ends[i] > from ? ends[i] : from
      guard to > from else { continue }

      // ⚠️ **秒から作った CMTime をそのまま渡さない。**
      //    秒 → timescale 600 の変換で端数が切り上がり、トラックの末尾を数ミリ秒超えることがある。
      //    AVAssetReader は超えても読める分だけ読むので単一ファイルでは表に出ないが、
      //    insertTimeRange は厳密で、範囲がトラックの外に出ると失敗する。
      //    2026-10-23、1時間19分（2ファイル）の文字起こしがこれで落ちていた。
      //    末尾ちょうどを選ぶのはむしろ普通の操作なので、必ず実際のトラックと重ねて丸める。
      let trackRange = try await Self.step("\(name) の長さの取得", {
        try await track.load(.timeRange)
      })
      let want = CMTimeRange(start: CMTime(seconds: from, preferredTimescale: 600),
                             end: CMTime(seconds: to, preferredTimescale: 600))
      let range = CMTimeRangeGetIntersection(want, otherRange: trackRange)
      guard range.duration > .zero else { continue }

      do {
        try compTrack.insertTimeRange(range, of: track, at: cursor)
      } catch {
        throw Exception(
          name: "CompositionFailed",
          description: Self.describe(error, where:
            "\(i + 1)本目（全\(uris.count)本）の連結 \(url.lastPathComponent) " +
            "\(String(format: "%.3f", CMTimeGetSeconds(range.start)))〜" +
            "\(String(format: "%.3f", CMTimeGetSeconds(CMTimeRangeGetEnd(range))))秒"))
      }
      cursor = CMTimeAdd(cursor, range.duration)
      used += 1
    }
    guard used > 0, cursor > .zero else {
      throw Exception(name: "EmptyRange", description: "切り出せる範囲がありませんでした")
    }

    // ⚠️ 合成トラックからは元のビットレートを読めない（estimatedDataRate が 0 になる）。
    //    連結した1本目の**元ファイル**から設定を作る。どのファイルも同じ設定で録っている。
    var useSettings = Self.aacSettingsDefault
    var measuredBps = 0
    var how = "default"
    if let given = settings {
      useSettings = given
    } else if let src = firstSourceTrack, let a = firstSourceAsset, let u = firstSourceURL {
      let m = await Self.aacSettingsMatching(src, asset: a, url: u)
      useSettings = m.settings
      measuredBps = m.measuredBps
      how = m.how
    }
    var out = try await runReaderWriter(asset: comp, track: compTrack,
                                        timeRange: CMTimeRange(start: .zero, duration: cursor),
                                        dst: dst, fileType: fileType, settings: useSettings)
    out["bitRate"] = useSettings[AVEncoderBitRateKey] ?? 0
    out["sampleRate"] = useSettings[AVSampleRateKey] ?? 0
    out["sourceBps"] = measuredBps
    out["sourceHow"] = how
    out["elapsedMs"] = Int(Date().timeIntervalSince(began) * 1000)
    out["startSec"] = 0.0
    out["endSec"] = CMTimeGetSeconds(cursor)
    out["requestedSec"] = CMTimeGetSeconds(cursor)
    out["partCount"] = used
    return out
  }

  /// 指定範囲を読み出して書き直す。AVAssetExportSession ではサンプルレートを
  /// 指定できないので、reader/writer で自分で回す。
  /// settings が nil のときは、元の音声と同じ形（サンプルレート・チャンネル・ビットレート）で書く。
  private static func transcode(src: URL, dst: URL, startSec: Double, endSec: Double,
                                fileType: AVFileType, settings: [String: Any]?) async throws -> [String: Any] {
    let began = Date()
    let asset = AVURLAsset(url: src)
    let tracks = try await Self.step("\(src.lastPathComponent) のトラック読み込み", {
      try await asset.loadTracks(withMediaType: .audio)
    })
    guard let track = tracks.first else {
      throw Exception(name: "NoAudioTrack", description: "音声トラックがありません: \(src.lastPathComponent)")
    }
    // ⚠️ **録音中のファイルは長さが 0 と返る**（CAF は読めるのに duration は未確定）。
    //    ここで total で丸めると、呼び出し側が正しい範囲を渡しても「範囲が空」で弾いてしまう。
    //    2026-10-21、録音中の切り出しが試せたはずなのに、この行のせいで検証が無効になった。
    //    長さが分からないときは、頼まれた範囲をそのまま読みに行って、取れた分を返す。
    let totalRaw = CMTimeGetSeconds(try await Self.step("\(src.lastPathComponent) の長さの取得", {
      try await asset.load(.duration)
    }))
    let total = totalRaw.isFinite && totalRaw > 0 ? totalRaw : 0
    let from = max(0, startSec)
    let to = total > 0 ? min(endSec > 0 ? endSec : total, total) : max(endSec, from)
    guard to > from else {
      throw Exception(name: "EmptyRange",
                      description: "範囲が空です (\(from) → \(to), 全体 \(total)秒)")
    }

    // ⚠️ `??` の右辺は非 async の autoclosure なので await を書けない。if で分ける
    let useSettings: [String: Any]
    var measuredBps = 0
    var how = "default"
    if let given = settings {
      useSettings = given
    } else {
      let m = await Self.aacSettingsMatching(track, asset: asset, url: src)
      useSettings = m.settings
      measuredBps = m.measuredBps
      how = m.how
    }
    var out = try await runReaderWriter(
      asset: asset, track: track,
      timeRange: CMTimeRange(start: CMTime(seconds: from, preferredTimescale: 600),
                             end: CMTime(seconds: to, preferredTimescale: 600)),
      dst: dst, fileType: fileType, settings: useSettings)
    out["bitRate"] = useSettings[AVEncoderBitRateKey] ?? 0
    out["sampleRate"] = useSettings[AVSampleRateKey] ?? 0
    out["sourceBps"] = measuredBps
    out["sourceHow"] = how
    out["startSec"] = from
    out["endSec"] = to
    out["requestedSec"] = to - from
    out["elapsedMs"] = Int(Date().timeIntervalSince(began) * 1000)
    return out
  }

  /// 資産の一部を読み出して書き直す共通処理。単数ファイルでも合成でも同じ経路を通す。
  ///
  /// ⚠️ AVAssetExportSession ではサンプルレートを指定できないので、reader/writer で自分で回す。
  private static func runReaderWriter(asset: AVAsset, track: AVAssetTrack,
                                      timeRange: CMTimeRange, dst: URL,
                                      fileType: AVFileType,
                                      settings: [String: Any]) async throws -> [String: Any] {
    let reader = try Self.step("読み出し器の作成", { try AVAssetReader(asset: asset) })
    reader.timeRange = timeRange
    // 読み出しは必ずリニアPCMに展開する（圧縮のままでは書き手に渡せない）。
    // ⚠️ 展開するサンプルレートは**書き出しに合わせる**。固定で 16kHz に開くと、
    //    12kHz の録音が 12k → 16k → 12k と2回変換され、遅くなるうえ音も余計に劣化する。
    var readSettings = pcmSettings
    if let rate = settings[AVSampleRateKey] { readSettings[AVSampleRateKey] = rate }
    if let ch = settings[AVNumberOfChannelsKey] { readSettings[AVNumberOfChannelsKey] = ch }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: readSettings)
    output.alwaysCopiesSampleData = false
    reader.add(output)

    try? FileManager.default.removeItem(at: dst)
    try Self.step("書き出し先の作成 \(dst.deletingLastPathComponent().lastPathComponent)", {
      try FileManager.default.createDirectory(at: dst.deletingLastPathComponent(),
                                              withIntermediateDirectories: true)
    })
    let writer = try Self.step("書き出し器の作成 \(dst.lastPathComponent)", {
      try AVAssetWriter(outputURL: dst, fileType: fileType)
    })
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    writer.add(input)

    guard writer.startWriting() else {
      throw Exception(name: "WriterFailed", description: Self.describe(writer.error, where: "書き出しの開始"))
    }
    writer.startSession(atSourceTime: .zero)
    guard reader.startReading() else {
      throw Exception(name: "ReaderFailed", description: Self.describe(reader.error, where: "読み出しの開始"))
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
      // ⚠️ localizedDescription だけだと "The operation could not be completed" にしかならず、
      //    何が起きたのか分からない（2026-10-23、1時間19分の切り出しで実際にそうなった）。
      //    どこで何番のエラーかを必ず載せる。
      throw Exception(name: "TranscodeFailed", description: Self.describe(writer.error, where: "書き出し"))
    }
    let size = (try? FileManager.default.attributesOfItem(atPath: dst.path)[.size] as? NSNumber)??.intValue ?? 0
    // 書けた実際の長さ。録音中のファイルからだと、頼んだ範囲より短くなることがある
    let wrote = CMTimeGetSeconds(try await Self.step("書けたファイルの長さの確認", {
      try await AVURLAsset(url: dst).load(.duration)
    }))
    let span = CMTimeGetSeconds(timeRange.duration)
    return [
      "uri": dst.path,
      "fileSize": size,
      "durationSec": wrote.isFinite && wrote > 0 ? wrote : span,
      "startSec": 0.0,
      "endSec": span,
      "requestedSec": span,
      "elapsedMs": 0
    ]
  }
}
