/// THE EVIDENCE CONTRACT, AS THE CHILD'S DEVICE SEES IT.
///
/// EVERY CONSTANT AND EVERY SIGNATURE IN THIS FILE IS A MIRROR OF
/// `apps/backend/src/shared/rewards/evidence.ts`. It is a mirror and NOT a
/// second opinion: the server re-reads the bytes, re-decides the type and
/// re-checks the size on every upload, and its answer is the only one that
/// counts. Nothing here can accept a file — it can only save a child on a
/// slow connection from spending three minutes uploading 15 MB that the
/// server was always going to refuse.
///
/// WHY THE CLIENT SNIFFS AT ALL, given it decides nothing. Two reasons, both
/// practical:
///
///   1. THE COURTESY. `MAX_EVIDENCE_BYTES` is 15 MiB. On a slow mobile link
///      that is minutes of a child's evening, and the reply at the end of it
///      is a "no" that was knowable before the first byte left.
///   2. THE CONTENT-TYPE IS LOAD-BEARING. The route's multer `fileFilter`
///      drops any part whose declared Content-Type is outside
///      `ALLOWED_EVIDENCE_MIME_TYPES`, and the controller then answers
///      `EVIDENCE_MISSING` — «لم يصل أي ملف» — for a file that did in fact
///      arrive. A picker's own claim about a file (`application/octet-stream`
///      is common) would trigger exactly that. So the type declared on the
///      wire is the one derived HERE from the bytes, by the same table the
///      server uses, which is the only way the two can agree.
///
/// THE MIRROR OBLIGATION, stated so it is not discovered later: if
/// `EVIDENCE_SIGNATURES` in evidence.ts gains a format and this table does
/// not, this client refuses a file the server would have accepted. That is a
/// missed upload, never a wrong verdict — but it is still a defect, and this
/// paragraph is where the next person is told to change both.
library;

/// The two evidence kinds. Derived by the SERVER from the program's
/// verification method (`evidenceKindForMethod`); the client never states a
/// kind on the wire and there is no field on the route by which it could.
/// This enum exists only to pick which BUTTONS to draw.
enum EvidenceKind { recitation, artifact }

/// How a child can produce a file. A UI routing concept — the server has no
/// idea which of these a given file came from and does not care.
enum EvidenceCaptureMode {
  /// Record a recitation, in-app, right now.
  recordAudio,

  /// Take a photo of the finished work.
  cameraPhoto,

  /// Choose a photo already on the device.
  galleryImage,

  /// Choose a document (a PDF worksheet, typically).
  document,
}

/// Why a file was not sent. CLIENT-LOCAL codes, deliberately prefixed so they
/// can never be confused with the server's own `EvidenceRejectionCode` in a
/// log or a bug report — these are courtesy pre-checks, the server's are
/// decisions.
enum EvidenceRefusal {
  /// Larger than [EvidenceContract.maxBytes].
  tooLarge,

  /// Smaller than [EvidenceContract.minBytes] — a recording that never
  /// actually started, almost always.
  tooSmall,

  /// The bytes match none of the signatures the server knows.
  typeUnrecognised,

  /// A real, valid file of the wrong kind for this program: an image for a
  /// recitation program, or a recording for an artifact program.
  typeWrongForKind,
}

/// One magic-byte signature, mirroring `MagicSignature` in evidence.ts.
class EvidenceSignature {
  const EvidenceSignature({
    required this.mimeType,
    required this.fileExtension,
    required this.kind,
    required this.offset,
    required this.bytes,
    this.alsoOffset,
    this.alsoBytes,
  });

  final String mimeType;

  /// Named `fileExtension`, not `extension`: the latter is a Dart built-in
  /// identifier and reads as a declaration keyword at a glance.
  final String fileExtension;

  final EvidenceKind kind;
  final int offset;
  final List<int> bytes;

  /// The second required signature, for container formats that need one —
  /// `RIFF` carries both WAVE and WEBP, so the first four bytes alone are
  /// ambiguous between an audio file and an image.
  final int? alsoOffset;
  final List<int>? alsoBytes;

  bool matches(List<int> header) {
    if (!_matchesAt(header, offset, bytes)) return false;
    final second = alsoBytes;
    final secondOffset = alsoOffset;
    if (second == null || secondOffset == null) return true;
    return _matchesAt(header, secondOffset, second);
  }

  static bool _matchesAt(List<int> header, int at, List<int> expected) {
    if (header.length < at + expected.length) return false;
    for (var i = 0; i < expected.length; i += 1) {
      if (header[at + i] != expected[i]) return false;
    }
    return true;
  }
}

/// What the client decided about a candidate file. NOT a verdict on the
/// evidence — see the library docstring.
class EvidenceInspection {
  const EvidenceInspection.accepted({
    required this.mimeType,
    required this.fileExtension,
  }) : refusal = null;

  const EvidenceInspection.refused(EvidenceRefusal reason)
      : mimeType = null,
        fileExtension = null,
        refusal = reason;

  /// The type derived FROM THE BYTES, which is what gets declared on the
  /// multipart part. Null when [refusal] is set.
  final String? mimeType;

  final String? fileExtension;

  final EvidenceRefusal? refusal;

  bool get isAccepted => refusal == null;
}

/// The mirror itself.
class EvidenceContract {
  EvidenceContract._();

  /// `MAX_EVIDENCE_BYTES` — 15 MiB.
  static const int maxBytes = 15 * 1024 * 1024;

  /// The same number in whole megabytes, for the sentence a child reads.
  static const int maxMegabytes = 15;

  /// `MIN_EVIDENCE_BYTES` — 64 bytes. An empty upload is a client bug, not
  /// evidence.
  static const int minBytes = 64;

  /// How many leading bytes [sniff] needs. The deepest signature is `WEBP` /
  /// `WAVE` at offset 8, so 12 would do; 16 is read instead so that adding a
  /// slightly deeper signature later does not silently start failing.
  static const int sniffWindow = 16;

  /// The multipart field name the route's `FileInterceptor('file', ...)`
  /// binds. A different name arrives as no file at all.
  static const String multipartFieldName = 'file';

  static const List<int> _id3 = [0x49, 0x44, 0x33]; // 'ID3'
  static const List<int> _ftyp = [0x66, 0x74, 0x79, 0x70]; // 'ftyp'
  static const List<int> _oggs = [0x4f, 0x67, 0x67, 0x53]; // 'OggS'
  static const List<int> _riff = [0x52, 0x49, 0x46, 0x46]; // 'RIFF'
  static const List<int> _wave = [0x57, 0x41, 0x56, 0x45]; // 'WAVE'
  static const List<int> _webp = [0x57, 0x45, 0x42, 0x50]; // 'WEBP'
  static const List<int> _pdf = [0x25, 0x50, 0x44, 0x46, 0x2d]; // '%PDF-'

  /// `EVIDENCE_SIGNATURES`, in the server's own order — [sniff] returns the
  /// FIRST match exactly as the server's `.find()` does, so an ambiguous
  /// header resolves identically on both sides.
  static const List<EvidenceSignature> signatures = [
    // -- audio: a recitation --
    EvidenceSignature(
      mimeType: 'audio/mpeg',
      fileExtension: 'mp3',
      kind: EvidenceKind.recitation,
      offset: 0,
      bytes: _id3,
    ),
    // MPEG frame sync with no ID3 tag — what a recorder that streams
    // straight to MP3 produces.
    EvidenceSignature(
      mimeType: 'audio/mpeg',
      fileExtension: 'mp3',
      kind: EvidenceKind.recitation,
      offset: 0,
      bytes: [0xff, 0xfb],
    ),
    EvidenceSignature(
      mimeType: 'audio/mpeg',
      fileExtension: 'mp3',
      kind: EvidenceKind.recitation,
      offset: 0,
      bytes: [0xff, 0xf3],
    ),
    // What `record` produces on Android: AAC in an MPEG-4 container.
    EvidenceSignature(
      mimeType: 'audio/mp4',
      fileExtension: 'm4a',
      kind: EvidenceKind.recitation,
      offset: 4,
      bytes: _ftyp,
    ),
    EvidenceSignature(
      mimeType: 'audio/ogg',
      fileExtension: 'ogg',
      kind: EvidenceKind.recitation,
      offset: 0,
      bytes: _oggs,
    ),
    EvidenceSignature(
      mimeType: 'audio/wav',
      fileExtension: 'wav',
      kind: EvidenceKind.recitation,
      offset: 0,
      bytes: _riff,
      alsoOffset: 8,
      alsoBytes: _wave,
    ),

    // -- images and documents: an artifact --
    EvidenceSignature(
      mimeType: 'image/jpeg',
      fileExtension: 'jpg',
      kind: EvidenceKind.artifact,
      offset: 0,
      bytes: [0xff, 0xd8, 0xff],
    ),
    EvidenceSignature(
      mimeType: 'image/png',
      fileExtension: 'png',
      kind: EvidenceKind.artifact,
      offset: 0,
      bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ),
    EvidenceSignature(
      mimeType: 'image/webp',
      fileExtension: 'webp',
      kind: EvidenceKind.artifact,
      offset: 0,
      bytes: _riff,
      alsoOffset: 8,
      alsoBytes: _webp,
    ),
    EvidenceSignature(
      mimeType: 'application/pdf',
      fileExtension: 'pdf',
      kind: EvidenceKind.artifact,
      offset: 0,
      bytes: _pdf,
    ),
  ];

  /// `evidenceKindForMethod`, mirrored. Null for the seven methods that take
  /// no file at all — and note that this is derived from the SERVER'S OWN
  /// MATRIX, not from what the method names sound like: `PARENT_CONFIRMATION`
  /// is a STRONG method that a parent decides and it uploads nothing, while
  /// `CODE_CHALLENGE` sends numbers rather than a file.
  static EvidenceKind? kindForVerificationLevel(String verificationLevel) {
    if (verificationLevel == 'RECITATION_SUBMISSION') return EvidenceKind.recitation;
    if (verificationLevel == 'COMPLETION_ARTIFACT') return EvidenceKind.artifact;
    return null;
  }

  /// Which capture buttons a kind gets, derived from the ALLOWED MIME TYPES
  /// for that kind rather than from its name:
  ///
  ///   RECITATION -> audio/mpeg, audio/mp4, audio/ogg, audio/wav
  ///                 -> one mode: record it. A child does not have a stray
  ///                    surah recording in their gallery, and an audio file
  ///                    arriving from anywhere else is not their recitation.
  ///   ARTIFACT   -> image/jpeg, image/png, image/webp, application/pdf
  ///                 -> three modes: the camera (the common case — a photo of
  ///                    the finished worksheet), an image already on the
  ///                    device, and a document, which is the ONLY route to
  ///                    the `application/pdf` that the server allows and
  ///                    neither camera nor gallery can produce.
  static List<EvidenceCaptureMode> modesFor(EvidenceKind kind) {
    switch (kind) {
      case EvidenceKind.recitation:
        return const [EvidenceCaptureMode.recordAudio];
      case EvidenceKind.artifact:
        return const [
          EvidenceCaptureMode.cameraPhoto,
          EvidenceCaptureMode.galleryImage,
          EvidenceCaptureMode.document,
        ];
    }
  }

  /// Every type the server will store for this kind. Exposed so a picker's
  /// filter and the check below cannot drift into two different lists.
  static List<String> mimeTypesFor(EvidenceKind kind) {
    final out = <String>[];
    for (final signature in signatures) {
      if (signature.kind == kind && !out.contains(signature.mimeType)) {
        out.add(signature.mimeType);
      }
    }
    return out;
  }

  /// The file extensions those types arrive as — what the document picker
  /// filters on, so a child is not shown files that cannot be sent.
  static List<String> extensionsFor(EvidenceKind kind) {
    final out = <String>[];
    for (final signature in signatures) {
      if (signature.kind == kind && !out.contains(signature.fileExtension)) {
        out.add(signature.fileExtension);
      }
    }
    return out;
  }

  /// The first signature whose bytes match, or null. Mirrors the server's
  /// `.find()` including its order.
  static EvidenceSignature? sniff(List<int> header) {
    for (final signature in signatures) {
      if (signature.matches(header)) return signature;
    }
    return null;
  }

  /// SIZE FIRST, THEN SIGNATURE, THEN KIND — the server's own order, kept so
  /// that a file refused here is refused for the same stated reason it would
  /// have been refused for there.
  static EvidenceInspection inspect({
    required int byteSize,
    required List<int> header,
    required EvidenceKind kind,
  }) {
    if (byteSize > maxBytes) {
      return const EvidenceInspection.refused(EvidenceRefusal.tooLarge);
    }
    if (byteSize < minBytes) {
      return const EvidenceInspection.refused(EvidenceRefusal.tooSmall);
    }
    final signature = sniff(header);
    if (signature == null) {
      return const EvidenceInspection.refused(EvidenceRefusal.typeUnrecognised);
    }
    if (signature.kind != kind) {
      return const EvidenceInspection.refused(EvidenceRefusal.typeWrongForKind);
    }
    return EvidenceInspection.accepted(
      mimeType: signature.mimeType,
      fileExtension: signature.fileExtension,
    );
  }
}

/// The localisation key for a refusal.
///
/// APP CHROME, THEREFORE `t()`, and this is the one place in the evidence
/// path where that is the right answer. Everywhere else the child reads the
/// SERVER'S sentence verbatim — but these four refusals happen BEFORE any
/// request is made, so there is no server sentence in existence yet. Every
/// key below is written in both `ar` and `en`, and every one of them names
/// the next thing to do rather than the thing that went wrong.
String evidenceRefusalMessageKey(EvidenceRefusal refusal, EvidenceKind kind) {
  switch (refusal) {
    case EvidenceRefusal.tooLarge:
      return 'session.evidence.tooLarge';
    case EvidenceRefusal.tooSmall:
      return 'session.evidence.tooSmall';
    case EvidenceRefusal.typeUnrecognised:
      return 'session.evidence.typeUnknown';
    case EvidenceRefusal.typeWrongForKind:
      return kind == EvidenceKind.recitation
          ? 'session.evidence.typeWrongRecitation'
          : 'session.evidence.typeWrongArtifact';
  }
}

/// A FILE THE DEVICE PRODUCED. Not yet sent, not yet anything.
///
/// Carries a PATH rather than bytes on purpose: a 15 MiB recitation held in
/// memory on a low-end device is a real out-of-memory risk, and Dio streams
/// straight from the file. [header] is the only part ever read into memory —
/// [EvidenceContract.sniffWindow] bytes, enough to decide the type.
class CapturedEvidence {
  const CapturedEvidence({
    required this.path,
    required this.filename,
    required this.byteSize,
    required this.header,
  });

  final String path;

  /// Sent as the multipart part's filename. The server stores it truncated to
  /// 255 characters and uses it for NOTHING else — the type comes from the
  /// bytes and the storage key is server-generated.
  final String filename;

  final int byteSize;

  /// The first [EvidenceContract.sniffWindow] bytes of the file.
  final List<int> header;
}

/// WHAT THE UPLOAD ROUTE ANSWERED: `{submissionRef, kind, mimeType,
/// byteSize}`.
///
/// READ THIS CAREFULLY, because it is the single most misreadable object in
/// the child app: a 201 here means THE BYTES ARRIVED AND WERE STORED. It does
/// not mean the recitation was heard, judged, accepted or rewarded. Both
/// methods that use this route have `canAutoApprove: false`, so a parent
/// decides afterwards, and no screen may render this receipt as an outcome.
///
/// [submissionRef] is an opaque uuid scoped to ONE achievement.
/// `AchievementService.submit` re-resolves it via
/// `assertBelongsToAchievement`, so it is worthless anywhere else and a
/// made-up one is rejected with `EVIDENCE_REF_INVALID`.
class EvidenceRef {
  const EvidenceRef({
    required this.submissionRef,
    required this.kind,
    required this.mimeType,
    required this.byteSize,
  });

  final String submissionRef;

  /// `RECITATION` | `ARTIFACT`, as the SERVER decided it from the program.
  /// Kept as the raw string: the client did not decide it and must not look
  /// as though it did.
  final String kind;

  /// The type the server derived FROM THE BYTES, which may legitimately
  /// differ from what this client sniffed. The server's wins, always.
  final String mimeType;

  final int byteSize;

  factory EvidenceRef.fromJson(Map<String, dynamic> json) => EvidenceRef(
        submissionRef: json['submissionRef']?.toString() ?? '',
        kind: json['kind']?.toString() ?? '',
        mimeType: json['mimeType']?.toString() ?? '',
        byteSize: (json['byteSize'] as num?)?.toInt() ?? 0,
      );

  /// A ref that is empty is a ref that cannot be submitted. Guarded rather
  /// than assumed, because `submit` would otherwise send `submissionRef: ''`
  /// and the child would read `EVIDENCE_REF_INVALID` for an upload that
  /// actually worked.
  bool get isUsable => submissionRef.isNotEmpty;
}
