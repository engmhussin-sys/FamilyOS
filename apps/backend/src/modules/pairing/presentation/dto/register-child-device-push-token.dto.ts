import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * ONE FIELD, AND THE MISSING FIELDS ARE THE POINT.
 *
 * `RegisterParentDevicePushTokenDto` beside this one carries `platform`, because
 * a parent's app instance may not have a `Device` row yet and the upsert has to
 * create one. A child device always has a row — pairing created it — and this
 * request is resolved to that row by the `deviceId` inside the VERIFIED device
 * token, so every other value the parent DTO needs is already known server-side:
 *
 *   deviceId  from `DeviceJwtAuthGuard`'s payload (`device.sub`)
 *   childId   from the device row
 *   familyId  from the device row
 *   platform  recorded at device registration
 *
 * None of them is accepted from the body, which is why child A cannot register a
 * token for child B and family A's device cannot attach itself to family B —
 * there is no field in which either could be said. `assert-tenant-scoping.ts`
 * (CI rule 3) fails the build for a request DTO carrying a `familyId`; this DTO
 * carries no identity at all.
 *
 * `@MaxLength(500)` matches the parent DTO and `Device.pushToken` — a longer
 * token is a 400, never a silent truncation that would store a token FCM can
 * never deliver to.
 */
export class RegisterChildDevicePushTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  pushToken!: string;
}
