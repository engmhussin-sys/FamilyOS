// THE EVIDENCE PATH — capture, courtesy check, upload, submissionRef.
//
// EXECUTION STATUS: NEVER RUN, NOT ONCE. There is no Dart SDK and no Flutter
// SDK reachable from the authoring environment, and none can be installed
// (pub.dev, dl.google.com and storage.googleapis.com all answer 403), so
// `flutter test` has never been invoked against this file. It is STATIC
// VERIFIED by scripts/dart_preflight.py, scripts/verify_dart_imports.py and
// scripts/verify_l10n_parity.py and by nothing else. Every claim below is a
// claim about what the code SAYS, checked by reading; none of them is a claim
// about observed behaviour.
//
// WHAT THESE TESTS ARE ACTUALLY GUARDING. Four of them are ordinary
// state-machine tests. The rest guard PRODUCT RULES that a well-meaning UI
// change could undo silently, and those are the ones worth keeping when this
// file is edited:
//
//   * A file the server would refuse never leaves the device — a courtesy,
//     because 15 MiB over a slow link is minutes of a child's evening.
//   * A FAILED upload does not submit and leaves no `submissionRef` behind,
//     so nothing can be sent as though it had worked.
//   * The client never renders an acceptance verdict. Both methods that reach
//     this path have `canAutoApprove: false` in the server's own verification
//     matrix — a parent decides — so "accepted" is not a tone problem here,
//     it is a false statement.
//
// Fakes are hand-written (`implements` + `noSuchMethod`), following
// test/features/coach/coach_test.dart, for the same reason it gives: mockito
// codegen needs `pub get`, and there is no `pub get` here.

import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/core/errors/api_failure.dart';
import 'package:child_app/core/localization/localization_engine.dart';
import 'package:child_app/features/goals/application/goal_session_controller.dart';
import 'package:child_app/features/goals/data/achievements_repository.dart';
import 'package:child_app/features/goals/data/evidence_capture_source.dart';
import 'package:child_app/features/goals/domain/child_achievement.dart';
import 'package:child_app/features/goals/domain/child_goal.dart';
import 'package:child_app/features/goals/domain/evidence.dart';

// ---------------------------------------------------------------------------
// Byte headers, copied from the server's own EVIDENCE_SIGNATURES so that a
// drift in the client mirror shows up here as a failing test rather than as a
// child's upload being refused on a device.
// ---------------------------------------------------------------------------

/// `ftyp` at offset 4 — AAC in an MPEG-4 container, which is exactly what
/// `record` produces and what the server sniffs as `audio/mp4`.
const List<int> _m4aHeader = [
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
  0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x00, 0x00,
];

/// JPEG — `image/jpeg`, an ARTIFACT signature.
const List<int> _jpegHeader = [
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
];

/// Matches nothing in the table at all.
const List<int> _garbageHeader = [
  0x7a, 0x7a, 0x7a, 0x7a, 0x00, 0x11, 0x22, 0x33,
  0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb,
];

TodayGoal _goal(String verificationLevel) => TodayGoal(
      programId: 'program-1',
      category: 'QURAN',
      activity: 'MEMORISE',
      targetSummaryAr: 'الآيات 1–5 من سورة الملك',
      durationMinutes: 10,
      reward: const GoalReward(type: 'POINTS', amount: 20),
      verificationLevel: verificationLevel,
      available: true,
    );

CapturedEvidence _file({
  required List<int> header,
  int byteSize = 200000,
  String filename = 'recitation.m4a',
}) =>
    CapturedEvidence(
      path: '/tmp/$filename',
      filename: filename,
      byteSize: byteSize,
      header: header,
    );

/// Records every upload and every submit, so a test can assert not only what
/// was sent but that nothing was.
class _FakeRepository implements ChildAchievementsRepository {
  _FakeRepository({this.uploadFailure, this.evidenceRef});

  ApiFailure? uploadFailure;
  EvidenceRef? evidenceRef;

  final List<Map<String, Object?>> uploads = [];
  final List<Map<String, Object?>> submits = [];

  @override
  Future<StartedAchievement> start(String programId) async => const StartedAchievement(
        id: 'achievement-1',
        programId: 'program-1',
        status: 'IN_PROGRESS',
        attemptNo: 1,
      );

  @override
  Future<EvidenceRef> uploadEvidence(
    String achievementId, {
    required String filePath,
    required String filename,
    required String mimeType,
  }) async {
    uploads.add({
      'achievementId': achievementId,
      'filePath': filePath,
      'filename': filename,
      'mimeType': mimeType,
    });
    if (uploadFailure != null) throw uploadFailure!;
    return evidenceRef ??
        const EvidenceRef(
          submissionRef: 'ref-from-server',
          kind: 'RECITATION',
          mimeType: 'audio/mp4',
          byteSize: 200000,
        );
  }

  @override
  Future<SubmitOutcome> submit(
    String achievementId, {
    bool? selfConfirmed,
    List<int>? quizAnswers,
    String? submissionRef,
    int? foregroundMinutes,
    String? note,
  }) async {
    submits.add({
      'achievementId': achievementId,
      'submissionRef': submissionRef,
      'note': note,
    });
    return const SubmitOutcome(
      status: 'PENDING_PARENT',
      result: 'ESCALATED',
      reasonCode: 'AWAITING_PARENT',
      messageAr: 'أرسلنا محاولتك إلى ولي الأمر ليطّلع عليها.',
      attemptsLeft: 2,
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// A recorder and two pickers that never touch a platform channel.
class _FakeCapture implements EvidenceCaptureSource {
  _FakeCapture({
    this.microphoneGranted = true,
    this.recorded,
    this.picked,
    this.captureThrows,
  });

  bool microphoneGranted;
  CapturedEvidence? recorded;
  CapturedEvidence? picked;
  EvidenceCaptureFailure? captureThrows;

  int micRequests = 0;
  int starts = 0;
  int discards = 0;
  bool disposed = false;
  final List<bool> imagePicks = [];
  int documentPicks = 0;

  @override
  Future<bool> requestMicrophonePermission() async {
    micRequests += 1;
    return microphoneGranted;
  }

  @override
  Future<void> startRecording() async {
    starts += 1;
    if (captureThrows != null) throw EvidenceCaptureException(captureThrows!);
  }

  @override
  Future<CapturedEvidence?> stopRecording() async {
    if (captureThrows != null) throw EvidenceCaptureException(captureThrows!);
    return recorded;
  }

  @override
  Future<void> discardRecording() async {
    discards += 1;
  }

  @override
  Future<bool> isRecording() async => false;

  @override
  Future<CapturedEvidence?> pickImage({required bool fromCamera}) async {
    imagePicks.add(fromCamera);
    if (captureThrows != null) throw EvidenceCaptureException(captureThrows!);
    return picked;
  }

  @override
  Future<CapturedEvidence?> pickDocument() async {
    documentPicks += 1;
    if (captureThrows != null) throw EvidenceCaptureException(captureThrows!);
    return picked;
  }

  @override
  Future<void> dispose() async {
    disposed = true;
  }
}

/// Builds a controller with an attempt already open, because every capture
/// entry point needs an `achievementId` to upload against.
Future<GoalSessionController> _startedSession(
  _FakeRepository repository,
  _FakeCapture capture, {
  String verificationLevel = 'RECITATION_SUBMISSION',
}) async {
  final controller = GoalSessionController(repository, _goal(verificationLevel), capture);
  addTearDown(controller.dispose);
  await controller.start();
  return controller;
}

void main() {
  // `ForegroundStopwatch.start()` attaches a WidgetsBindingObserver, so the
  // binding has to exist before `controller.start()` is called.
  TestWidgetsFlutterBinding.ensureInitialized();

  group('the courtesy checks refuse before the network', () {
    test('an oversized recitation is refused before upload, in the child\'s own words',
        () async {
      final repository = _FakeRepository();
      final capture = _FakeCapture(
        recorded: _file(
          header: _m4aHeader,
          // One byte past the server's MAX_EVIDENCE_BYTES.
          byteSize: EvidenceContract.maxBytes + 1,
        ),
      );
      final controller = await _startedSession(repository, capture);

      await controller.startRecitation();
      await controller.stopRecitation();

      // NOT SENT. This is the whole point: the server would have refused it
      // with EVIDENCE_TOO_LARGE, and the child would have waited out 15 MiB
      // on a phone connection to be told so.
      expect(repository.uploads, isEmpty);
      expect(controller.state.evidence.submissionRef, isNull);
      expect(controller.state.evidence.phase, EvidencePhase.idle);

      final key = controller.state.evidence.noticeKey;
      expect(key, 'session.evidence.tooLarge');

      // A REAL SENTENCE IN BOTH LOCALES, not a raw key leaking onto a screen.
      // `translate` falls back to the key itself when nothing is declared,
      // which is exactly the failure this asserts against.
      final arabic = translate(AppLocale.ar, key!, options: {'mb': EvidenceContract.maxMegabytes});
      final english = translate(AppLocale.en, key, options: {'mb': EvidenceContract.maxMegabytes});
      expect(arabic, isNot(key));
      expect(english, isNot(key));
      // It names the limit and the way forward rather than the mistake.
      expect(arabic.contains('${EvidenceContract.maxMegabytes}'), isTrue);
    });

    test('a photo sent to a recitation goal is refused, and says which is wanted', () async {
      final repository = _FakeRepository();
      final capture = _FakeCapture(recorded: _file(header: _jpegHeader, filename: 'page.jpg'));
      final controller = await _startedSession(repository, capture);

      await controller.startRecitation();
      await controller.stopRecitation();

      // A perfectly valid JPEG — and still not a recitation. Only the KIND
      // makes it wrong, which is why the check needs the goal and not just
      // the bytes.
      expect(repository.uploads, isEmpty);
      expect(controller.state.evidence.noticeKey, 'session.evidence.typeWrongRecitation');
      expect(controller.state.evidence.submissionRef, isNull);
    });

    test('a recording sent to an artifact goal is refused the other way round', () async {
      final repository = _FakeRepository();
      final capture = _FakeCapture(picked: _file(header: _m4aHeader, filename: 'voice.m4a'));
      final controller = await _startedSession(
        repository,
        capture,
        verificationLevel: 'COMPLETION_ARTIFACT',
      );

      await controller.attachDocument();

      expect(repository.uploads, isEmpty);
      expect(controller.state.evidence.noticeKey, 'session.evidence.typeWrongArtifact');
    });

    test('a file matching no signature at all is refused as unrecognised', () async {
      final repository = _FakeRepository();
      final capture = _FakeCapture(recorded: _file(header: _garbageHeader));
      final controller = await _startedSession(repository, capture);

      await controller.startRecitation();
      await controller.stopRecitation();

      expect(repository.uploads, isEmpty);
      expect(controller.state.evidence.noticeKey, 'session.evidence.typeUnknown');
    });

    test('a file below the server\'s 64-byte floor is refused', () async {
      final repository = _FakeRepository();
      final capture = _FakeCapture(
        recorded: _file(header: _m4aHeader, byteSize: EvidenceContract.minBytes - 1),
      );
      final controller = await _startedSession(repository, capture);

      await controller.startRecitation();
      await controller.stopRecitation();

      expect(repository.uploads, isEmpty);
      expect(controller.state.evidence.noticeKey, 'session.evidence.tooSmall');
    });

    test('every refusal sentence exists in BOTH locales', () {
      for (final refusal in EvidenceRefusal.values) {
        for (final kind in EvidenceKind.values) {
          final key = evidenceRefusalMessageKey(refusal, kind);
          expect(translate(AppLocale.ar, key), isNot(key),
              reason: 'no Arabic for $key');
          expect(translate(AppLocale.en, key), isNot(key),
              reason: 'no English for $key');
        }
      }
    });
  });

  group('a successful upload', () {
    test('sends the type derived from the BYTES, not the picker\'s claim', () async {
      final repository = _FakeRepository();
      final capture = _FakeCapture(recorded: _file(header: _m4aHeader));
      final controller = await _startedSession(repository, capture);

      await controller.startRecitation();
      await controller.stopRecitation();

      expect(repository.uploads, hasLength(1));
      // If this were ever `application/octet-stream`, multer's fileFilter on
      // the route would DROP the part and the child would read «لم يصل أي
      // ملف» about a file that arrived intact.
      expect(repository.uploads.single['mimeType'], 'audio/mp4');
      expect(repository.uploads.single['achievementId'], 'achievement-1');
      expect(repository.uploads.single['filePath'], '/tmp/recitation.m4a');
    });

    test('passes the server\'s ref to submit, unchanged', () async {
      final repository = _FakeRepository(
        evidenceRef: const EvidenceRef(
          submissionRef: 'evidence-uuid-42',
          kind: 'RECITATION',
          mimeType: 'audio/mp4',
          byteSize: 200000,
        ),
      );
      final capture = _FakeCapture(recorded: _file(header: _m4aHeader));
      final controller = await _startedSession(repository, capture);

      await controller.startRecitation();
      await controller.stopRecitation();

      expect(controller.state.evidence.hasStoredFile, isTrue);
      expect(controller.state.evidence.submissionRef, 'evidence-uuid-42');

      // Uploading is NOT submitting. Nothing has been submitted yet.
      expect(repository.submits, isEmpty);

      await controller.submit(note: 'خلصت');

      expect(repository.submits, hasLength(1));
      expect(repository.submits.single['submissionRef'], 'evidence-uuid-42');
    });

    test('a goal that takes no file never sends a ref', () async {
      final repository = _FakeRepository();
      final capture = _FakeCapture();
      final controller = await _startedSession(repository, capture,
          verificationLevel: 'SELF_CHECK');

      await controller.submit();

      expect(repository.submits.single['submissionRef'], isNull);
      // And no capture entry point does anything on a goal with no kind.
      await controller.startRecitation();
      await controller.attachPhoto();
      expect(capture.starts, 0);
      expect(capture.imagePicks, isEmpty);
    });

    test('a 2xx with an empty ref is not treated as an attachment', () async {
      final repository = _FakeRepository(
        evidenceRef: const EvidenceRef(
          submissionRef: '',
          kind: 'RECITATION',
          mimeType: 'audio/mp4',
          byteSize: 10,
        ),
      );
      final capture = _FakeCapture(recorded: _file(header: _m4aHeader));
      final controller = await _startedSession(repository, capture);

      await controller.startRecitation();
      await controller.stopRecitation();

      // `submit` would otherwise send `submissionRef: ''` and the child would
      // read EVIDENCE_REF_INVALID about an upload that worked.
      expect(controller.state.evidence.hasStoredFile, isFalse);
      expect(controller.state.evidence.submissionRef, isNull);
    });
  });

  group('a failed upload', () {
    test('does not submit, and claims nothing', () async {
      final repository = _FakeRepository(
        uploadFailure: const ApiFailure(
          message: 'Payload too large',
          messageAr: 'الملف أكبر من الحد المسموح (15 ميجابايت). سجّل مقطعًا أقصر أو بجودة أقل.',
          code: 'EVIDENCE_TOO_LARGE',
          statusCode: 400,
        ),
      );
      final capture = _FakeCapture(recorded: _file(header: _m4aHeader));
      final controller = await _startedSession(repository, capture);

      await controller.startRecitation();
      await controller.stopRecitation();

      expect(repository.uploads, hasLength(1));
      // NOTHING WAS SUBMITTED. The upload path has no call to `submit` at all,
      // and this is the test that keeps it that way.
      expect(repository.submits, isEmpty);

      final evidence = controller.state.evidence;
      expect(evidence.submissionRef, isNull);
      expect(evidence.hasStoredFile, isFalse);
      expect(evidence.phase, EvidencePhase.idle);
      // The server's own sentence is what the child will read.
      expect(evidence.failure?.code, 'EVIDENCE_TOO_LARGE');
      expect(evidence.failure?.display, contains('ميجابايت'));

      // And if the child presses send anyway, no stale ref rides along.
      await controller.submit();
      expect(repository.submits.single['submissionRef'], isNull);
    });

    test('a microphone the child declined is not a failure and not a telling-off',
        () async {
      final repository = _FakeRepository();
      final capture = _FakeCapture(microphoneGranted: false);
      final controller = await _startedSession(repository, capture);

      await controller.startRecitation();

      expect(capture.micRequests, 1);
      expect(capture.starts, 0);
      expect(repository.uploads, isEmpty);
      expect(controller.state.evidence.noticeKey, 'session.evidence.micDenied');
      expect(controller.state.evidence.failure, isNull);
      // The sentence points at the way round, not at the child.
      final arabic = translate(AppLocale.ar, 'session.evidence.micDenied');
      expect(arabic, isNot('session.evidence.micDenied'));
    });

    test('a recorder the device refused reports a device problem, not a refusal',
        () async {
      final repository = _FakeRepository(
        evidenceRef: const EvidenceRef(
          submissionRef: 'never',
          kind: 'RECITATION',
          mimeType: 'audio/mp4',
          byteSize: 1,
        ),
      );
      final capture = _FakeCapture(captureThrows: EvidenceCaptureFailure.deviceRefused);
      final controller = await _startedSession(repository, capture);

      await controller.startRecitation();

      expect(controller.state.evidence.noticeKey, 'session.evidence.captureFailed');
      expect(repository.uploads, isEmpty);
      expect(controller.state.evidence.submissionRef, isNull);
    });

    test('backing out of the picker says nothing at all', () async {
      final repository = _FakeRepository();
      // `picked` stays null: the child opened the camera and changed their
      // mind, which is a normal thing a child does.
      final capture = _FakeCapture();
      final controller = await _startedSession(
        repository,
        capture,
        verificationLevel: 'COMPLETION_ARTIFACT',
      );

      await controller.attachPhoto();

      expect(capture.imagePicks, [true]);
      expect(repository.uploads, isEmpty);
      expect(controller.state.evidence.noticeKey, isNull);
      expect(controller.state.evidence.failure, isNull);
      expect(controller.state.evidence.phase, EvidencePhase.idle);
    });
  });

  group('the client states no verdict', () {
    test('there is no phase, and no flag, that means accepted', () {
      // The state machine cannot express approval. If a future change adds a
      // value here that can, this test is the thing that has to be argued
      // with first — and the argument has to be with the server's
      // verification matrix, where BOTH of these methods carry
      // `canAutoApprove: false`.
      final names = EvidencePhase.values.map((phase) => phase.name.toLowerCase()).toList();
      for (final forbidden in ['accept', 'verif', 'approv', 'pass', 'grant', 'reward']) {
        expect(names.any((name) => name.contains(forbidden)), isFalse,
            reason: 'EvidencePhase must not model an outcome: found "$forbidden"');
      }
    });

    test('no sentence on the evidence path claims the evidence was accepted', () {
      // The keys the evidence card and the controller can render. Read as
      // data so that adding a key without reading this rule fails here.
      const keys = [
        'session.evidence.artifactHow',
        'session.evidence.camera',
        'session.evidence.cancelRecording',
        'session.evidence.captureFailed',
        'session.evidence.document',
        'session.evidence.gallery',
        'session.evidence.micDenied',
        'session.evidence.micWhy',
        'session.evidence.none',
        'session.evidence.notAttachedYet',
        'session.evidence.recitationHow',
        'session.evidence.record',
        'session.evidence.recording',
        'session.evidence.replace',
        'session.evidence.stop',
        'session.evidence.stored',
        'session.evidence.storedHint',
        'session.evidence.tooLarge',
        'session.evidence.tooSmall',
        'session.evidence.typeUnknown',
        'session.evidence.typeWrongArtifact',
        'session.evidence.typeWrongRecitation',
        'session.evidence.uploadFailedTitle',
        'session.evidence.uploading',
      ];

      // English words that would state an outcome, and the Arabic ones that
      // would do the same in Egyptian colloquial. «اتبعت» (it was sent) is
      // fine and is what the card actually says; «اتقبل» (it was accepted)
      // is not.
      const forbiddenEn = [
        'accepted', 'approved', 'verified', 'passed', 'correct', 'well done',
        'you earned', 'you won', 'points', 'prize', 'reward',
      ];
      const forbiddenAr = [
        'اتقبل', 'مقبول', 'تم قبول', 'اتحقق', 'تم التحقق', 'نجحت', 'برافو',
        'جايزة', 'مكافأة', 'كسبت',
      ];

      for (final key in keys) {
        final english = translate(AppLocale.en, key).toLowerCase();
        final arabic = translate(AppLocale.ar, key);
        expect(english, isNot(key), reason: '$key has no English');
        expect(arabic, isNot(key), reason: '$key has no Arabic');
        for (final word in forbiddenEn) {
          expect(english.contains(word), isFalse,
              reason: '$key states an outcome in English: "$word"');
        }
        for (final word in forbiddenAr) {
          expect(arabic.contains(word), isFalse,
              reason: '$key states an outcome in Arabic: "$word"');
        }
      }
    });

    test('the contract mirrors the server, kind by kind', () {
      // Guards the mirror in domain/evidence.dart against drift. These four
      // lists are `ALLOWED_EVIDENCE_MIME_TYPES` split by kind, as
      // shared/rewards/evidence.ts declares them.
      expect(
        EvidenceContract.mimeTypesFor(EvidenceKind.recitation),
        ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav'],
      );
      expect(
        EvidenceContract.mimeTypesFor(EvidenceKind.artifact),
        ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      );
      expect(EvidenceContract.maxBytes, 15 * 1024 * 1024);
      expect(EvidenceContract.minBytes, 64);
      expect(EvidenceContract.multipartFieldName, 'file');

      // The kind is read off the SERVER'S matrix, not off the method name.
      expect(EvidenceContract.kindForVerificationLevel('RECITATION_SUBMISSION'),
          EvidenceKind.recitation);
      expect(EvidenceContract.kindForVerificationLevel('COMPLETION_ARTIFACT'),
          EvidenceKind.artifact);
      for (final level in [
        'DURATION',
        'SELF_CHECK',
        'PARENT_CONFIRMATION',
        'QUIZ',
        'ASSESSMENT_SCORE',
        'CODE_CHALLENGE',
        'DURATION_PLUS_QUIZ',
      ]) {
        expect(EvidenceContract.kindForVerificationLevel(level), isNull,
            reason: '$level takes no file on the server');
      }

      // One mode for a recitation; three for an artifact, because
      // `application/pdf` is reachable from neither camera nor gallery.
      expect(EvidenceContract.modesFor(EvidenceKind.recitation),
          [EvidenceCaptureMode.recordAudio]);
      expect(EvidenceContract.modesFor(EvidenceKind.artifact), [
        EvidenceCaptureMode.cameraPhoto,
        EvidenceCaptureMode.galleryImage,
        EvidenceCaptureMode.document,
      ]);
    });

    test('RIFF is not decided by its first four bytes', () {
      // WAVE and WEBP share the RIFF container: one is a recitation and the
      // other is an artifact, and only the bytes at offset 8 tell them apart.
      // Getting this wrong would refuse a valid recording as an image.
      const wav = [
        0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00,
        0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
      ];
      const webp = [
        0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
      ];
      expect(EvidenceContract.sniff(wav)?.mimeType, 'audio/wav');
      expect(EvidenceContract.sniff(webp)?.mimeType, 'image/webp');
      expect(EvidenceContract.sniff(_garbageHeader), isNull);
    });
  });
}
