#if os(iOS)
import AVFAudio
import AudioToolbox
import Foundation

/// Converts only the supplied Watch file. Recognition is owned by the restricted Oops backend.
@available(iOS 26.0, *)
@MainActor
final class PhoneAudioProcessing {
    enum ProcessingError: LocalizedError {
        case invalidAudioFile
        case emptyAudio
        case segmentTooLong
        case audioOpenFailed(domain: String, code: Int)
        case audioReadFailed(domain: String, code: Int, frame: Int64, total: Int64)
        case conversionUnavailable
        case conversionFailed

        var errorDescription: String? {
            switch self {
            case .invalidAudioFile: return "无法读取这段手表录音，请重新传输音频。"
            case .emptyAudio: return "这段手表录音没有有效音频，不能转写或上传。"
            case .segmentTooLong: return "单段手表录音不能超过 30 秒，请先分段再处理。"
            case let .audioOpenFailed(domain, code):
                return "无法打开手表录音（\(domain)：\(code)）；原音仍保留。"
            case let .audioReadFailed(domain, code, frame, total):
                return "读取手表录音失败（\(domain)：\(code)，帧 \(frame)/\(total)）；原音仍保留。"
            case .conversionUnavailable: return "无法把这段录音转换为 16 kHz 单声道音频。"
            case .conversionFailed: return "音频转换未完成，请重新处理这段录音。"
            }
        }
    }

    /// Decodes the supplied file and returns headerless 16 kHz / mono / signed 16-bit LE PCM.
    /// It does not request microphone access, record audio, or upload anything.
    func pcm16k(fileURL: URL) throws -> Data {
        try Task.checkCancellation()
        let file = try audioFile(fileURL: fileURL)
        guard let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                               sampleRate: 16_000,
                                               channels: 1,
                                               interleaved: true),
              let converter = AVAudioConverter(from: file.processingFormat, to: outputFormat),
              let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4_096),
              let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 4_096) else {
            throw ProcessingError.conversionUnavailable
        }
        converter.downmix = true

        var pcm = Data()
        pcm.reserveCapacity(Int(ceil(Double(file.length) / file.processingFormat.sampleRate * 16_000)) * 2)
        let totalFrames = file.length
        var inputEnded = false
        var inputFailure: ProcessingError?
        var decodedFrames: Int64 = 0
        var emptyDrainPasses = 0
        while true {
            try Task.checkCancellation()
            let previousPosition = file.framePosition
            output.frameLength = 0
            var conversionError: NSError?
            let status = converter.convert(to: output, error: &conversionError) { requestedFrames, inputStatus in
                guard !inputEnded, inputFailure == nil else {
                    inputStatus.pointee = .endOfStream
                    return nil
                }
                let remaining = totalFrames - file.framePosition
                guard remaining > 0 else {
                    inputEnded = true
                    inputStatus.pointee = .endOfStream
                    return nil
                }
                // A final AAC read can contain fewer valid frames than the buffer capacity.
                // Never request past the valid-frame length, or perform another read at EOF.
                let frames = AVAudioFrameCount(min(Int64(input.frameCapacity), min(Int64(max(1, requestedFrames)), remaining)))
                input.frameLength = 0
                do {
                    try file.read(into: input, frameCount: frames)
                } catch {
                    let error = error as NSError
                    if error.domain == NSOSStatusErrorDomain, error.code == Int(kAudioFileEndOfFileError),
                       decodedFrames + Int64(input.frameLength) == totalFrames {
                        inputEnded = true
                        if input.frameLength > 0 {
                            decodedFrames += Int64(input.frameLength)
                            inputStatus.pointee = .haveData
                            return input
                        }
                        inputStatus.pointee = .endOfStream
                        return nil
                    }
                    inputFailure = .audioReadFailed(domain: error.domain, code: error.code,
                                                    frame: file.framePosition, total: totalFrames)
                    inputStatus.pointee = .endOfStream
                    return nil
                }
                guard input.frameLength > 0 else {
                    inputEnded = true
                    inputStatus.pointee = .endOfStream
                    return nil
                }
                decodedFrames += Int64(input.frameLength)
                inputStatus.pointee = .haveData
                return input
            }
            if let inputFailure { throw inputFailure }
            guard conversionError == nil, status != .error else { throw ProcessingError.conversionFailed }
            if output.frameLength > 0 {
                guard let samples = output.int16ChannelData?[0] else {
                    throw ProcessingError.conversionFailed
                }
                #if _endian(little)
                pcm.append(Data(bytes: samples, count: Int(output.frameLength) * MemoryLayout<Int16>.size))
                #else
                for index in 0..<Int(output.frameLength) {
                    var sample = samples[index].littleEndian
                    withUnsafeBytes(of: &sample) { pcm.append(contentsOf: $0) }
                }
                #endif
            }
            // Bound converter output as well as source duration; never loop forever on stalled input.
            guard pcm.count <= 16_000 * 2 * 31 else { throw ProcessingError.conversionFailed }
            if status == .endOfStream { break }
            if output.frameLength > 0 || file.framePosition > previousPosition {
                emptyDrainPasses = 0
            } else {
                // EOS may require a following conversion call before the converter reports EOS.
                // Valid buffered output does not require the file cursor to advance.
                emptyDrainPasses += 1
                guard inputEnded, emptyDrainPasses <= 2 else { throw ProcessingError.conversionFailed }
            }
        }
        guard decodedFrames == totalFrames else {
            throw ProcessingError.audioReadFailed(domain: NSOSStatusErrorDomain, code: Int(kAudioFileEndOfFileError),
                                                 frame: decodedFrames, total: totalFrames)
        }
        guard !pcm.isEmpty else { throw ProcessingError.emptyAudio }
        return pcm
    }

    private func audioFile(fileURL: URL) throws -> AVAudioFile {
        guard fileURL.isFileURL, FileManager.default.isReadableFile(atPath: fileURL.path) else {
            throw ProcessingError.invalidAudioFile
        }
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: fileURL, commonFormat: .pcmFormatFloat32, interleaved: false)
        } catch {
            let error = error as NSError
            throw ProcessingError.audioOpenFailed(domain: error.domain, code: error.code)
        }
        let rate = file.processingFormat.sampleRate
        guard rate.isFinite, rate > 0, file.processingFormat.channelCount > 0, file.length > 0 else {
            throw ProcessingError.emptyAudio
        }
        guard Double(file.length) / rate <= 30 else { throw ProcessingError.segmentTooLong }
        return file
    }
}
#endif
