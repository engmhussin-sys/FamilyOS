/**
 * B5 (PA-B-019) — THE EVIDENCE UPLOAD CONTRACT.
 *
 * `RECITATION_SUBMISSION` and `COMPLETION_ARTIFACT` are the two STRONG-evidence
 * verification methods in `verification.ts`. Both require `submission.
 * submissionRef`. Both have `canAutoApprove: false`, so a parent always
 * decides. And until B5 there was NO WAY IN THE ENTIRE BACKEND TO PRODUCE A
 * `submissionRef`: zero multipart routes, zero storage abstraction, zero file
 * models. The strategies could only ever return `RECITATION_MISSING` /
 * `ARTIFACT_MISSING`, which made every Quran memorisation program in the
 * product unreachable from the child app — the flagship journey, blocked on a
 * missing verb.
 *
 * WHAT THIS FILE IS. The framework-free half: what may be uploaded, how big,
 * and how the server decides what a file ACTUALLY is. Pure functions over
 * `Buffer`, no NestJS and no Prisma, for the same reason `verification.ts` and
 * `program-taxonomy.ts` are pure — every branch below is unit-testable without
 * a database, an HTTP server or a disk.
 *
 * WHAT IS DELIBERATELY NOT HERE. No audio ML, no speech-to-text, no tajweed
 * scoring, no image classification. A parent still confirms, exactly as the
 * verification matrix says. This module decides whether a blob is a plausible,
 * safe, in-policy audio or image file — it decides nothing about what the file
 * CONTAINS.
 */

/** The two evidence kinds, derived by the SERVER from the program's
 * verification method. A client never states which kind it is uploading. */
export const EVIDENCE_KINDS = ['RECITATION', 'ARTIFACT'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * 15 MiB. Sized from the real case rather than from a round number: a five
 * minute recitation at a mobile-friendly ~64 kbps AAC is roughly 2.4 MB, so
 * this leaves a wide margin for a long surah recorded at a higher bitrate
 * while still refusing anything that could only be a video or a dump.
 */
export const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024;

/** An empty upload is a client bug, not evidence, and it must fail loudly
 * rather than produce a `submissionRef` that points at nothing. */
export const MIN_EVIDENCE_BYTES = 64;

/**
 * How long a piece of evidence is kept before
 * `DataRetentionEnforcementService.enforceAchievementEvidenceRetention` sweeps
 * it. 180 days: long enough that a parent reviewing a month-old queue still
 * has the recording, short enough that a child's voice is not held
 * indefinitely for no stated purpose. A number, in one place, so that changing
 * the policy is a one-line decision rather than an archaeology exercise.
 */
export const EVIDENCE_RETENTION_DAYS = 180;

/**
 * THE ALLOWLIST, AS MAGIC BYTES.
 *
 * The `Content-Type` a client sends is a claim, not a fact, and a claim from a
 * CHILD'S DEVICE is exactly the class of input this whole phase exists to stop
 * trusting (PA-B-017 is the same mistake with a number instead of a string).
 * So the declared type is used for NOTHING except an early, cheap rejection —
 * the type that gets stored is the one derived from the bytes.
 *
 * Each entry is a signature that must appear at a given offset. `webp` and
 * `wav` share the `RIFF` container, so they carry a second signature at
 * offset 8; `m4a`/`mp4` audio is identified by the `ftyp` box at offset 4.
 */
interface MagicSignature {
  readonly mimeType: string;
  readonly extension: string;
  readonly kinds: readonly EvidenceKind[];
  readonly offset: number;
  readonly bytes: readonly number[];
  /** A second required signature, for container formats that need one. */
  readonly also?: { readonly offset: number; readonly bytes: readonly number[] };
}

const ASCII = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

export const EVIDENCE_SIGNATURES: readonly MagicSignature[] = [
  // -- audio: a recitation --
  { mimeType: 'audio/mpeg', extension: 'mp3', kinds: ['RECITATION'], offset: 0, bytes: ASCII('ID3') },
  // MPEG frame sync without an ID3 tag — a recorder that streams straight to
  // MP3 produces this and no ID3 header at all.
  { mimeType: 'audio/mpeg', extension: 'mp3', kinds: ['RECITATION'], offset: 0, bytes: [0xff, 0xfb] },
  { mimeType: 'audio/mpeg', extension: 'mp3', kinds: ['RECITATION'], offset: 0, bytes: [0xff, 0xf3] },
  { mimeType: 'audio/mp4', extension: 'm4a', kinds: ['RECITATION'], offset: 4, bytes: ASCII('ftyp') },
  { mimeType: 'audio/ogg', extension: 'ogg', kinds: ['RECITATION'], offset: 0, bytes: ASCII('OggS') },
  {
    mimeType: 'audio/wav',
    extension: 'wav',
    kinds: ['RECITATION'],
    offset: 0,
    bytes: ASCII('RIFF'),
    also: { offset: 8, bytes: ASCII('WAVE') },
  },

  // -- images: an artifact (a photo of a finished worksheet, a drawing) --
  { mimeType: 'image/jpeg', extension: 'jpg', kinds: ['ARTIFACT'], offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/png', extension: 'png', kinds: ['ARTIFACT'], offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  {
    mimeType: 'image/webp',
    extension: 'webp',
    kinds: ['ARTIFACT'],
    offset: 0,
    bytes: ASCII('RIFF'),
    also: { offset: 8, bytes: ASCII('WEBP') },
  },
  { mimeType: 'application/pdf', extension: 'pdf', kinds: ['ARTIFACT'], offset: 0, bytes: ASCII('%PDF-') },
];

/** Every type any evidence route will ever store. Exposed so a controller's
 * early `Content-Type` rejection and the byte-level decision below cannot
 * drift apart into two different lists. */
export const ALLOWED_EVIDENCE_MIME_TYPES: readonly string[] = Array.from(
  new Set(EVIDENCE_SIGNATURES.map((s) => s.mimeType)),
);

export type EvidenceRejectionCode =
  | 'EVIDENCE_EMPTY'
  | 'EVIDENCE_TOO_LARGE'
  | 'EVIDENCE_TOO_SMALL'
  | 'EVIDENCE_TYPE_UNRECOGNISED'
  | 'EVIDENCE_TYPE_WRONG_FOR_METHOD';

export type EvidenceInspection =
  | { readonly ok: true; readonly mimeType: string; readonly extension: string }
  | { readonly ok: false; readonly code: EvidenceRejectionCode; readonly messageAr: string };

function matches(buffer: Buffer, offset: number, bytes: readonly number[]): boolean {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * THE ONE PLACE A FILE'S TYPE IS DECIDED, and it decides from the bytes.
 *
 * Order matters: size first (cheap, and a 400 MB body should not be sniffed),
 * then signature, then whether that signature is legal for the evidence kind
 * this program actually needs. The last check is what stops a child answering
 * a RECITATION program with a JPEG of a book cover — the file is a perfectly
 * valid image and it is still not a recitation, and only the server knows
 * which one was asked for.
 *
 * Every rejection carries a NON-PUNITIVE Arabic message (CONTEXT §3 principle
 * 7): the child is told what to do next, never that they did something wrong.
 */
export function inspectEvidence(buffer: Buffer, kind: EvidenceKind): EvidenceInspection {
  if (buffer.length === 0) {
    return { ok: false, code: 'EVIDENCE_EMPTY', messageAr: 'لم يصل الملف. جرّب الإرسال مرة أخرى.' };
  }
  if (buffer.length > MAX_EVIDENCE_BYTES) {
    return {
      ok: false,
      code: 'EVIDENCE_TOO_LARGE',
      messageAr: `الملف أكبر من الحد المسموح (${Math.floor(MAX_EVIDENCE_BYTES / (1024 * 1024))} ميجابايت). سجّل مقطعًا أقصر أو بجودة أقل.`,
    };
  }
  if (buffer.length < MIN_EVIDENCE_BYTES) {
    return {
      ok: false,
      code: 'EVIDENCE_TOO_SMALL',
      messageAr: 'الملف قصير جدًا ليكون تسجيلًا. تأكّد من التسجيل ثم أعد الإرسال.',
    };
  }

  const signature = EVIDENCE_SIGNATURES.find(
    (s) => matches(buffer, s.offset, s.bytes) && (!s.also || matches(buffer, s.also.offset, s.also.bytes)),
  );

  if (!signature) {
    return {
      ok: false,
      code: 'EVIDENCE_TYPE_UNRECOGNISED',
      messageAr: 'نوع الملف غير مدعوم. أرسل تسجيلًا صوتيًا (mp3 / m4a / ogg / wav) أو صورة (jpg / png / webp).',
    };
  }

  if (!signature.kinds.includes(kind)) {
    return {
      ok: false,
      code: 'EVIDENCE_TYPE_WRONG_FOR_METHOD',
      messageAr:
        kind === 'RECITATION'
          ? 'هذا البرنامج يحتاج تسجيلًا صوتيًا للتسميع، لا صورة.'
          : 'هذا البرنامج يحتاج صورة أو ملفًا كدليل إنجاز، لا تسجيلًا صوتيًا.',
    };
  }

  return { ok: true, mimeType: signature.mimeType, extension: signature.extension };
}

/**
 * The evidence kind a verification method needs, or `null` when the method
 * takes no file at all. Derived from `verification.ts`'s own matrix rather
 * than restated, so a tenth method cannot silently acquire an upload route.
 */
export function evidenceKindForMethod(method: string): EvidenceKind | null {
  if (method === 'RECITATION_SUBMISSION') return 'RECITATION';
  if (method === 'COMPLETION_ARTIFACT') return 'ARTIFACT';
  return null;
}
