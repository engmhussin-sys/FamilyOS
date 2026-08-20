import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../domain/evidence.dart';
import 'evidence_capture_source.dart';

/// THE FOUR PLUGINS, BEHIND ONE PORT.
///
/// This is the only file in the child app that imports `record`,
/// `image_picker`, `file_picker` or `path_provider`. Everything above it —
/// the controller, the repository, the screen and every test — sees
/// [EvidenceCaptureSource] and nothing else, which is what keeps the upload
/// logic testable in an environment with no platform channels.
///
/// NOTHING IN THIS FILE HAS BEEN RUN. No Dart SDK exists here and pub.dev
/// answers 403, so none of these four packages was ever resolved, let alone
/// executed. Every API call below is written against the published API of the
/// exact version pinned in pubspec.yaml.
class PlatformEvidenceCaptureSource implements EvidenceCaptureSource {
  PlatformEvidenceCaptureSource({
    AudioRecorder? recorder,
    ImagePicker? imagePicker,
  })  : _recorder = recorder ?? AudioRecorder(),
        _imagePicker = imagePicker ?? ImagePicker();

  final AudioRecorder _recorder;
  final ImagePicker _imagePicker;

  /// Where the current recording is being written. Held so
  /// [discardRecording] can delete a file that `stop()` will never name.
  String? _recordingPath;

  /// THE ENCODER SETTINGS, AND THE ARITHMETIC BEHIND THEM.
  ///
  /// AAC-LC in an MPEG-4 container, which the server sniffs as `audio/mp4`
  /// from the `ftyp` box at offset 4 — one of the four RECITATION signatures.
  ///
  /// 64 kbps, 22.05 kHz, MONO is not a quality compromise made carelessly: it
  /// is a child's voice, and it is the same budget evidence.ts sized its
  /// 15 MiB ceiling from («a five minute recitation at a mobile-friendly
  /// ~64 kbps AAC is roughly 2.4 MB»). At this bitrate the ceiling is reached
  /// at about 31 minutes, which is longer than any recitation this product
  /// asks for — so a child recording a real surah cannot hit the size
  /// refusal, which is the entire point of choosing the numbers rather than
  /// accepting the defaults (128 kbps stereo would halve that headroom for
  /// no audible gain on speech).
  static const RecordConfig _recitationConfig = RecordConfig(
    encoder: AudioEncoder.aacLc,
    bitRate: 64000,
    sampleRate: 22050,
    numChannels: 1,
  );

  @override
  Future<bool> requestMicrophonePermission() async {
    try {
      // `record`'s own name for this is misleading and worth spelling out:
      // hasPermission() CHECKS AND REQUESTS. It is the runtime request, it
      // shows the system dialog, and it is why RECORD_AUDIO in the manifest
      // is not a dead declaration.
      return await _recorder.hasPermission();
    } catch (_) {
      return false;
    }
  }

  @override
  Future<void> startRecording() async {
    try {
      // Android has no `/tmp`, so Dart's own `Directory.systemTemp` is not
      // usable here — this is the app's private cache directory, which the
      // OS may reclaim and which needs no permission.
      final directory = await getTemporaryDirectory();
      final stamp = DateTime.now().millisecondsSinceEpoch;
      final target = '${directory.path}/abny_recitation_$stamp.m4a';
      await _recorder.start(_recitationConfig, path: target);
      _recordingPath = target;
    } catch (_) {
      _recordingPath = null;
      throw const EvidenceCaptureException(EvidenceCaptureFailure.deviceRefused);
    }
  }

  @override
  Future<CapturedEvidence?> stopRecording() async {
    try {
      final produced = await _recorder.stop();
      final target = produced ?? _recordingPath;
      _recordingPath = null;
      if (target == null) return null;
      return _describe(target);
    } on EvidenceCaptureException {
      rethrow;
    } catch (_) {
      _recordingPath = null;
      throw const EvidenceCaptureException(EvidenceCaptureFailure.deviceRefused);
    }
  }

  @override
  Future<void> discardRecording() async {
    final target = _recordingPath;
    _recordingPath = null;
    try {
      await _recorder.cancel();
    } catch (_) {
      // Cancelling a recorder that is not running is not a problem worth
      // surfacing to a nine-year-old, or to anything else.
    }
    if (target == null) return;
    try {
      final file = File(target);
      if (await file.exists()) await file.delete();
    } catch (_) {
      // Best effort. A leftover file in the cache directory is the OS's to
      // reclaim; failing to delete it must not fail the screen teardown.
    }
  }

  @override
  Future<bool> isRecording() async {
    try {
      return await _recorder.isRecording();
    } catch (_) {
      return false;
    }
  }

  @override
  Future<CapturedEvidence?> pickImage({required bool fromCamera}) async {
    try {
      final picked = await _imagePicker.pickImage(
        source: fromCamera ? ImageSource.camera : ImageSource.gallery,
        // RE-ENCODED, and that is deliberate on both counts. `imageQuality`
        // makes image_picker hand back JPEG — `image/jpeg`, an ARTIFACT
        // signature — instead of whatever the camera app chose, and the
        // bound keeps a modern 50 MP sensor's output far below the 15 MiB
        // ceiling. A photo of a worksheet does not need more than this.
        imageQuality: 85,
        maxWidth: 2400,
        maxHeight: 2400,
      );
      if (picked == null) return null;
      return _describe(picked.path, filename: picked.name);
    } on EvidenceCaptureException {
      rethrow;
    } catch (_) {
      throw const EvidenceCaptureException(EvidenceCaptureFailure.deviceRefused);
    }
  }

  @override
  Future<CapturedEvidence?> pickDocument() async {
    try {
      final result = await FilePicker.platform.pickFiles(
        // FILTERED TO WHAT THE SERVER ACCEPTS, from the mirror rather than a
        // hand-written list, so the picker cannot offer a child a file that
        // the upload was always going to refuse.
        type: FileType.custom,
        allowedExtensions: EvidenceContract.extensionsFor(EvidenceKind.artifact),
        allowMultiple: false,
        // The bytes stay on disk. `withData: true` would load up to 15 MiB
        // into memory on a low-end device for no reason — Dio streams the
        // file straight from its path.
        withData: false,
      );
      if (result == null || result.files.isEmpty) return null;
      final picked = result.files.first;
      final path = picked.path;
      if (path == null) return null;
      return _describe(path, filename: picked.name);
    } on EvidenceCaptureException {
      rethrow;
    } catch (_) {
      throw const EvidenceCaptureException(EvidenceCaptureFailure.deviceRefused);
    }
  }

  @override
  Future<void> dispose() async {
    try {
      await _recorder.dispose();
    } catch (_) {
      // Nothing above this can act on a failed teardown.
    }
  }

  /// Reads the size and the first [EvidenceContract.sniffWindow] bytes.
  ///
  /// ONLY THE HEADER IS READ INTO MEMORY. The rest of the file is never
  /// loaded by this app at all — it is streamed by Dio from this path.
  Future<CapturedEvidence> _describe(String path, {String? filename}) async {
    try {
      final file = File(path);
      final byteSize = await file.length();
      final handle = await file.open();
      List<int> header;
      try {
        header = await handle.read(EvidenceContract.sniffWindow);
      } finally {
        await handle.close();
      }
      return CapturedEvidence(
        path: path,
        filename: filename ?? _basename(path),
        byteSize: byteSize,
        header: header,
      );
    } catch (_) {
      throw const EvidenceCaptureException(EvidenceCaptureFailure.deviceRefused);
    }
  }

  /// The last path segment, without pulling in `package:path` for one line.
  /// Compared as code units (0x2F `/`, 0x5C backslash) so that a desktop
  /// host's separator is handled without a literal that reads as an escape.
  static String _basename(String path) {
    var cut = -1;
    for (var i = path.length - 1; i >= 0; i -= 1) {
      final unit = path.codeUnitAt(i);
      if (unit == 0x2f || unit == 0x5c) {
        cut = i;
        break;
      }
    }
    final name = cut == -1 ? path : path.substring(cut + 1);
    return name.isEmpty ? 'evidence' : name;
  }
}
