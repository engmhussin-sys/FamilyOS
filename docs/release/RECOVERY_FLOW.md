# Crash Recovery Flow

Text-based flow diagrams for each recovery scenario, grounded in real,
already-built components — no new mechanism invented for this document.

## Parent App Crash

```
App crashes (any screen)
  -> OS relaunches on next user tap
  -> SplashScreen.checkSession() reads SecureSessionStorage
     -> session exists -> Dashboard (re-fetches all data fresh)
     -> no session -> Login
  -> PendingOperationsQueue (persisted in secure storage) is untouched
     by the crash — drains normally on next connectivity-change event
```
No in-memory state survives a crash by design — every screen re-fetches
on mount rather than relying on cached state.

## Child App Crash (Flutter engine)

```
Flutter engine crashes
  -> Foreground Service (native, separate process) UNAFFECTED —
     enforcement continues from NativePolicyStore's cached policy
  -> HeartbeatService (Dart Timer) stops — a real, documented gap
     (HeartbeatService's own docstring): heartbeats stop even though the
     native service keeps enforcing locally
  -> OS may relaunch the Flutter engine on next app open
     -> RecoveryCoordinator.attemptRecoveryIfNeeded() re-syncs policy
        if it looks stale
```

## Foreground Service Crash (native)

```
ChildGuardForegroundService killed by OS
  -> START_STICKY requests OS restart (OEM behavior varies — see
     DEVICE_VALIDATION_MATRIX.md's "App Kill Behavior" row)
  -> RuntimeWatchdogWorker (WorkManager, independent process) is a
     SECOND recovery path, ~15-minute cycle
  -> BootReceiver is a THIRD recovery path, but only on actual reboot
```
Three independent, overlapping recovery mechanisms — deliberate
redundancy since no single one is guaranteed on every OEM skin.

## Watchdog

```
RuntimeWatchdogWorker (~15 min cycle)
  -> checks isAccessibilityServiceEnabled()
  -> if false: RuntimeAlertNotifier fires a high-importance notification
  -> does NOT attempt to re-enable Accessibility itself — no API allows
     that; only the user can, via Settings
```

## Queue Recovery (Offline Queue, both apps)

```
Write/heartbeat fails (offline, timeout, 5xx)
  -> enqueued to persistent storage
  -> capped (200 child / 100 parent entries), oldest dropped first
  -> next successful network operation triggers drain()
  -> drain stops at the FIRST failure (assumes still offline)
```

## Policy Recovery

```
Child App resumes from background
  -> RecoveryCoordinator checks: accessibilityServiceEnabled &&
     hasEverSyncedPolicy
     -> if either false: re-sync policy, restart enforcement service
     -> does NOT attempt to fix Accessibility itself
```

## Token Refresh (both apps, same design)

```
API call returns 401
  -> already retried? skip-auth flagged? if neither: attempt refresh
  -> concurrent 401s share ONE in-flight refresh
  -> success -> retry original request once
  -> failure -> clear local session
     -> Parent App: sessionExpiredProvider fires, force-navigates to Login
     -> Child App: device-actor session dies; re-pairing required —
        no equivalent "session expired" UI exists for the device flow
        today, a real gap surfaced by writing this document
```

## Offline Queue -> Sync, end to end

```
Connectivity lost
  -> Child: heartbeats queue, local enforcement continues regardless
  -> Parent: write actions queue, OfflineBanner shows pending count
Connectivity restored
  -> Child: next successful heartbeat drains the queue
  -> Parent: online transition drains the queue
  -> Both: stops at first failure, remainder stays queued
```
