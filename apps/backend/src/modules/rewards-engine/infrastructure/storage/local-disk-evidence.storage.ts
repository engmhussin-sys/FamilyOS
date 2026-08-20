import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import type { IEvidenceStorage } from '../../application/ports/evidence-storage.port';

/**
 * B5 (PA-B-019) — THE LOCAL-DISK ADAPTER, and the documented target it is not.
 *
 * ACCEPTABLE FOR NOW, AND SAID SO EXPLICITLY. This is the implementation that
 * lets the whole recitation journey run end to end today, on a developer
 * machine and in CI, with no cloud credentials. It is NOT the production
 * answer: a local directory does not survive a container restart, does not
 * replicate, and does not encrypt at rest without help from the host.
 *
 * THE DOCUMENTED TARGET is an S3-compatible object store (S3, R2, MinIO) with
 * server-side encryption, a lifecycle rule mirroring `EVIDENCE_RETENTION_DAYS`
 * as a second line of defence behind the application's own sweep, and no
 * public access. Swapping it is one provider binding in `RewardsEngineModule`
 * because `IEvidenceStorage` has four verbs and none of them leaks a path.
 *
 * PATH SAFETY, since this adapter is the one that touches a real filesystem:
 * `resolve()` below rejects any key that escapes the configured root after
 * normalisation. Keys are server-composed today and contain only uuids, so no
 * caller can currently reach this check — which is exactly when a traversal
 * guard should be written, rather than after the first key that includes a
 * filename.
 */
@Injectable()
export class LocalDiskEvidenceStorage implements IEvidenceStorage {
  readonly backendName = 'local-disk';

  private readonly logger = new Logger(LocalDiskEvidenceStorage.name);
  private readonly root: string;

  constructor() {
    // A single env var with a working default. Deliberately not a NestJS
    // `ConfigService` lookup: this class is constructed in test contexts that
    // do not boot the config module, and a storage root is not a secret.
    this.root = path.resolve(process.env.EVIDENCE_STORAGE_ROOT ?? path.join(process.cwd(), '.evidence-store'));
  }

  async put(key: string, bytes: Buffer, _mimeType: string): Promise<void> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // 0600: the process owner and nobody else. An S3 adapter's equivalent is
    // "no public ACL, SSE on", and both are stated rather than defaulted.
    await fs.writeFile(target, bytes, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch (err) {
      // Absent is the desired end state, so it is not an error. Retention has
      // to be re-runnable for the same reason every migration in this repo is.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private resolve(key: string): string {
    const target = path.resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      // Not a 400: a key that escapes the root cannot come from a client — it
      // could only come from a bug in key composition, and that is a server
      // fault that must be loud.
      this.logger.error(`Rejected an evidence key that escapes the storage root: ${key}`);
      throw new Error('Evidence key escapes the storage root');
    }
    return target;
  }
}
