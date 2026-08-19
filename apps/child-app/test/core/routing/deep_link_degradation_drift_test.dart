// THE DEGRADATION TABLE IS THE SERVER'S. THIS FILE FAILS WHEN THE COPY OF IT
// IN THIS APP STOPS MATCHING.
//
// ---------------------------------------------------------------------------
// WHAT IS COPIED, AND WHY IT IS A LIABILITY.
//
// `deep_link.dart`'s `_idLessFormOf` holds three pairs — `goal → goals`,
// `approval → approvals`, `safety → screen-time` — that were read out of
// `apps/backend/src/modules/notifications/domain/engine/notification-destination.ts`,
// where they are the third argument of `idLink(...)`:
//
//     idLink('goal',     facts.programId,     surfaceLink('goals'))
//     idLink('approval', facts.achievementId, surfaceLink('approvals'))
//     idLink('safety',   facts.alertId,       surfaceLink('screen-time'))
//
// A table copied off another system does not announce that the original moved.
// If the server gains a fourth id-bearing surface, or changes where one of
// these three degrades to, this app keeps applying yesterday's rule and a child
// lands somewhere the server did not send them — silently, with nothing red
// anywhere. That is exactly the failure mode this file is written to remove.
//
// ---------------------------------------------------------------------------
// WHAT IS NOT A DEFECT, AND IS NOT ASSERTED HERE.
//
// The two apps deliberately do DIFFERENT things with the same link — the child
// app has no approval queue, no subscription screen and no per-child routing,
// so several parent surfaces resolve to the child's own home. That split is
// documented in `deep_link.dart` and `child_deep_link_router.dart` and is
// asserted in `deep_link_test.dart`. It stays. This file is about ONE thing:
// whether the id-less DEGRADATION this app applies still equals the one the
// server publishes.
//
// ---------------------------------------------------------------------------
// WHAT THE SERVER SHOULD DO INSTEAD, STATED HERE BECAUSE IT CANNOT BE DONE
// FROM THIS PACKAGE.
//
// The right fix is not a better copy. `notification-destination.ts` already
// computes the degraded link — `idLink` returns `surfaceLink('goals')` itself
// when the id is missing — so THE SERVER SHOULD SHIP THE DEGRADED SURFACE
// rather than leave each client to re-derive it: either by emitting the
// already-degraded `abny://goals` (which it does today on every producer path,
// making the client table dead weight in the common case), or by exposing the
// pairs in the same published contract that carries `DEEP_LINK_SCHEME`, so a
// client reads them instead of transcribing them. Until that happens this test
// is the seam, and it is a detector rather than a fix.
//
// ---------------------------------------------------------------------------
// EXECUTION STATUS: NEVER RUN. There is no Flutter SDK and no Dart SDK in the
// authoring environment, so this file has never been executed. It is STATIC
// VERIFIED by `scripts/dart_preflight.py` and `scripts/verify_dart_imports.py`
// only. It reads a file off disk at run time and asserts nothing about the
// network.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/core/routing/deep_link.dart';

/// `idLink('<surface>', <facts field>, surfaceLink('<fallback>'))` — the one
/// shape the server writes a degradation in. Deliberately narrow: a rule
/// written some other way should FAIL to be found rather than be quietly
/// skipped, and [_serverPairs] refuses an empty result for that reason.
final RegExp _idLinkCall = RegExp(
  r"idLink\(\s*'([a-z-]+)'\s*,[^,]+,\s*surfaceLink\(\s*'([a-z-]+)'\s*\)\s*\)",
);

/// The backend file, found by walking up from wherever the test runner started.
/// `flutter test` runs with the package root as its working directory, but that
/// is a convention rather than a guarantee, so the walk is the honest way to
/// locate a sibling package.
File? _findDestinationSource() {
  const relative = 'apps/backend/src/modules/notifications/domain/engine/'
      'notification-destination.ts';
  var dir = Directory.current.absolute;
  for (var i = 0; i < 8; i++) {
    final candidate = File('${dir.path}/$relative');
    if (candidate.existsSync()) return candidate;
    final parent = dir.parent;
    if (parent.path == dir.path) break;
    dir = parent;
  }
  return null;
}

/// True when `apps/backend` is not in this checkout at all — a client-only
/// clone. Distinguished from «the backend is here and the file is not», which
/// is a real failure and is reported as one.
bool _backendAbsent() {
  var dir = Directory.current.absolute;
  for (var i = 0; i < 8; i++) {
    if (Directory('${dir.path}/apps/backend').existsSync()) return false;
    final parent = dir.parent;
    if (parent.path == dir.path) break;
    dir = parent;
  }
  return true;
}

/// `{id-bearing wire name: fallback wire name}` as the SERVER writes it.
Map<String, String> _serverPairs(String source) {
  final pairs = <String, String>{};
  for (final match in _idLinkCall.allMatches(source)) {
    pairs[match.group(1)!] = match.group(2)!;
  }
  return pairs;
}

/// What THIS app does with the id-less form of [wireName], as a wire name.
String _clientDegradesTo(String wireName) =>
    deepLinkSurfaceWireName(parseDeepLink('abny://$wireName').surface);

void main() {
  group('the id-less degradation table matches the server\'s', () {
    test('the server file is readable — a copied table with nothing to compare '
        'against is the defect, not the check', () {
      if (_backendAbsent()) {
        // A client-only checkout. Nothing to compare against and nothing
        // claimed; the test below skips for the same reason.
        return;
      }
      expect(
        _findDestinationSource(),
        isNotNull,
        reason: 'apps/backend is in this checkout but '
            'notification-destination.ts was not found where this app expects '
            'it. The degradation table in deep_link.dart is a copy of that '
            'file and can no longer be checked against it.',
      );
    });

    test('EVERY degradation the server publishes is the one this app applies',
        () {
      final source = _findDestinationSource();
      if (source == null) {
        if (_backendAbsent()) return;
        fail('notification-destination.ts not found — see the test above.');
      }

      final pairs = _serverPairs(source.readAsStringSync());

      expect(
        pairs,
        isNotEmpty,
        reason: 'No `idLink(..., surfaceLink(...))` rule was found in '
            'notification-destination.ts. Either the server stopped writing '
            'degradations that way, or it stopped writing them at all — and '
            'either way the table copied into deep_link.dart is now '
            'unverifiable. Read the server and update both.',
      );

      // The three that were transcribed, plus ANY the server has added since.
      // A new pair the client does not know about degrades to the inbox, so
      // the comparison below names it rather than passing quietly.
      final clientPairs = <String, String>{
        for (final surface in pairs.keys) surface: _clientDegradesTo(surface),
      };

      expect(
        clientPairs,
        pairs,
        reason: 'The server and this app disagree about where an id-less link '
            'degrades to. The server is authoritative: update '
            '`_idLessFormOf` in lib/core/routing/deep_link.dart to match, and '
            'read the note at the top of this file about why the server '
            'should be shipping the degraded surface instead.',
      );
    });

    test('the three pairs this app was written against are still among them',
        () {
      final source = _findDestinationSource();
      if (source == null) {
        if (_backendAbsent()) return;
        fail('notification-destination.ts not found — see the first test.');
      }

      final pairs = _serverPairs(source.readAsStringSync());

      // Named individually so a removal reads as «the server dropped goals»
      // rather than as one opaque map mismatch.
      expect(pairs['goal'], 'goals');
      expect(pairs['approval'], 'approvals');
      expect(pairs['safety'], 'screen-time');
    });
  });
}
