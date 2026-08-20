/// ONE ROW OF THE REAL DOMAIN CATALOGUE — `GET /self/catalogue/domains`.
///
/// The server builds this from the child's own age (derived from
/// `dateOfBirth` on the family's calendar, never from anything the device
/// sends) and returns EVERY domain at EVERY age, annotated rather than
/// filtered. `learning-catalogue.ts` states the reason in the backend's own
/// words: «a catalogue that silently dropped domains would teach a child the
/// product is smaller than it is, and a nine-year-old who wants to learn to
/// code would never learn that PROGRAMMING exists.» That is the same
/// dimmed-never-hidden convention this app already applies, decided on the
/// server so the two cannot drift.
library;

class CatalogueDomainRow {
  const CatalogueDomainRow({
    required this.code,
    required this.labelAr,
    required this.suggestedAtThisAge,
  });

  /// `QURAN`, `PROGRAMMING`, … — a machine value. It is matched against a
  /// goal's `category` and used to pick an icon; it is never rendered.
  final String code;

  /// The server's own Arabic name for the domain, written for this child's
  /// age band. Rendered VERBATIM — never routed through `t()`, which would
  /// swap a sentence the safety engine has passed for one it has not.
  ///
  /// `null` when the server sent nothing usable, in which case the chooser
  /// falls back to its own `category.*` label rather than showing a blank
  /// chip.
  final String? labelAr;

  /// `suitability.suggestedAtThisAge`. NOT a lock and NOT a reason to hide
  /// anything: the chooser uses it only to keep the server's ordering
  /// meaningful when it re-sorts.
  final bool suggestedAtThisAge;

  /// WHAT IS DELIBERATELY NOT PARSED: `contentKind`, `contentKindLabelAr`,
  /// `activityCount` and `suitability.noteAr`. Every one of them is real and
  /// on the wire, and nothing on this screen renders any of them — a model
  /// field no widget reads is a promise the UI does not keep. They are one
  /// line away the day a screen needs them.
  factory CatalogueDomainRow.fromJson(Map<String, dynamic> json) {
    final labelAr = json['labelAr']?.toString().trim();
    final suitability = json['suitability'];
    return CatalogueDomainRow(
      code: json['code']?.toString().trim() ?? '',
      labelAr: (labelAr == null || labelAr.isEmpty) ? null : labelAr,
      suggestedAtThisAge:
          suitability is Map && suitability['suggestedAtThisAge'] == true,
    );
  }
}
