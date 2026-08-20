import '../domain/evidence.dart';

/// THE PORT BETWEEN "A CHILD PRESSED RECORD" AND FOUR PLUGINS.
///
/// WHY THIS INTERFACE EXISTS AT ALL, given there is exactly one production
/// implementation: without it, every test of the upload path would construct
/// `AudioRecorder`, `ImagePicker` and `FilePicker.platform`, all of which
/// reach a MethodChannel that does not exist under `flutter_test`. The
/// interesting logic — refuse an oversized file, refuse a wrong type, send a
/// ref to `submit`, never claim success — would then be the one part of this
/// feature nothing could exercise. Same reason every backend service in this
/// repository takes a repository port rather than Prisma.
///
/// WHAT AN IMPLEMENTATION MAY AND MAY NOT DO:
///   - It produces a [CapturedEvidence] or it produces nothing. It never
///     validates, never uploads and never decides.
///   - A child who backs out of the camera or the picker is NOT an error:
///     that is `null`, and the UI shows nothing at all. Cancelling is a
///     normal thing a child does and must never produce a message.
///   - A real failure — a recorder the OS refused to start, a file that
///     vanished — throws [EvidenceCaptureException].
abstract class EvidenceCaptureSource {
  /// Asks for RECORD_AUDIO and reports whether recording is now possible.
  ///
  /// DECLARED IN THE MANIFEST, THEREFORE REQUESTED HERE. `RECORD_AUDIO` is a
  /// dangerous permission on every API level, and on Android 13+ a permission
  /// that is declared but never requested is simply invisible — the recorder
  /// fails and nothing explains why. `verify_notification_permission.py`
  /// enforces exactly that conjunction for this app, and it now covers this
  /// permission too.
  ///
  /// THE CALLER MUST HAVE EXPLAINED IT FIRST. `session.evidence.micWhy` is
  /// that explanation and it sits above the record button, so the system
  /// dialog is never the first time a child hears why the microphone is
  /// wanted.
  ///
  /// Never throws: a channel failure reads as `false`, which is honest — the
  /// microphone is not available — and an exception thrown from inside a
  /// permission prompt is strictly worse.
  Future<bool> requestMicrophonePermission();

  /// Begins recording to a file this source owns.
  Future<void> startRecording();

  /// Stops and returns the file, or null if nothing was captured.
  Future<CapturedEvidence?> stopRecording();

  /// Stops and DELETES. Used when the screen goes away mid-recording — a
  /// half-recorded surah left in the cache directory is dead weight on a
  /// device that may not have much room.
  Future<void> discardRecording();

  /// True while [startRecording] is in effect. Read on teardown so the
  /// controller does not cancel a recorder that was never started.
  Future<bool> isRecording();

  /// The camera (`fromCamera: true`) or the device's own photo picker.
  Future<CapturedEvidence?> pickImage({required bool fromCamera});

  /// A document — the only route to the `application/pdf` the server allows.
  Future<CapturedEvidence?> pickDocument();

  /// Releases the native recorder.
  Future<void> dispose();
}

/// The device could not produce a file, for a reason that is not the child
/// declining and not the child cancelling.
///
/// Carries NO message: the sentence a child reads is chosen by the UI from
/// [reason] via `t()`, in both `ar` and `en`, and is never an exception's
/// `toString()` — a Dart error string is the one thing in this app that is
/// guaranteed to be English, technical and frightening.
class EvidenceCaptureException implements Exception {
  const EvidenceCaptureException(this.reason);

  final EvidenceCaptureFailure reason;

  @override
  String toString() => 'EvidenceCaptureException(${reason.name})';
}

enum EvidenceCaptureFailure {
  /// The child said no to the microphone, or Android has stopped asking.
  microphoneUnavailable,

  /// The recorder or the picker failed. Nothing the child did.
  deviceRefused,
}
