import '../errors/api_failure.dart';

/// THE FOUR STATES, MADE STRUCTURAL.
///
/// Audit PA-M-044 found that every screen in this app re-invents its own
/// loading/empty/error handling with ad-hoc `bool _isLoading` +
/// `String? _errorMessage` pairs, which is why several screens render an
/// EMPTY list and a FAILED fetch identically (`dashboard_home_screen.dart`
/// carried exactly that bug until its own review caught it).
///
/// A `bool`+`String?` pair has four representable combinations and only
/// three legal ones. This type has exactly four, all legal, and the
/// compiler will not let a screen forget one — which is how "39 states"
/// stops being a checklist and becomes a property of the code.
///
/// DELIBERATELY NOT `AsyncValue`. Riverpod's `AsyncValue` collapses
/// "loaded, and there is nothing" into `data(<empty list>)`, so every
/// consumer must then write its own `isEmpty` branch — i.e. exactly the
/// per-screen re-invention this type exists to remove. `empty` is a
/// first-class state here.
///
/// DELIBERATELY NOT A SEALED CLASS + PATTERN MATCHING. This repository has
/// never once run `dart analyze` (audit PA-M-014), so exhaustiveness that
/// only a compiler can check buys nothing today and costs a whole class of
/// unverifiable syntax. [when] gives the same "handle all four" pressure
/// through a signature that requires all four arguments.
enum UiStatus { loading, empty, error, data }

class UiState<T> {
  const UiState._(this.status, this._value, this.failure);

  const UiState.loading() : this._(UiStatus.loading, null, null);

  /// Loaded successfully, and the answer is legitimately "nothing yet".
  const UiState.empty() : this._(UiStatus.empty, null, null);

  const UiState.error(ApiFailure failure) : this._(UiStatus.error, null, failure);

  const UiState.data(T value) : this._(UiStatus.data, value, null);

  final UiStatus status;
  final T? _value;
  final ApiFailure? failure;

  bool get isLoading => status == UiStatus.loading;
  bool get isEmpty => status == UiStatus.empty;
  bool get isError => status == UiStatus.error;
  bool get hasData => status == UiStatus.data;

  /// Non-null only when [hasData]. Callers inside a `data` branch of [when]
  /// receive the value as a parameter and never need this.
  T? get valueOrNull => _value;

  /// Builds a list-backed state in the ONE place that decides what "empty"
  /// means, so no screen ever answers that question for itself again.
  static UiState<List<E>> fromList<E>(List<E> items) =>
      items.isEmpty ? UiState<List<E>>.empty() : UiState<List<E>>.data(items);

  /// All four branches are required. That is the entire point.
  R when<R>({
    required R Function() loading,
    required R Function() empty,
    required R Function(ApiFailure failure) error,
    required R Function(T value) data,
  }) {
    switch (status) {
      case UiStatus.loading:
        return loading();
      case UiStatus.empty:
        return empty();
      case UiStatus.error:
        return error(failure!);
      case UiStatus.data:
        return data(_value as T);
    }
  }
}
