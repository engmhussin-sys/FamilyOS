/// THE PARENT APP DESIGN SYSTEM — one import for every new screen.
///
/// Audit PA-M-044 (🔴 High): "لا يوجد Design System … كل شاشة تعيد بناء
/// حالتها بنفسها". This barrel is the answer's front door: tokens
/// (colour / spacing / radius / elevation / motion / text roles), eight
/// named components, and the four state widgets bound to [UiState].
///
/// It deliberately does NOT export `UiState` itself — that is application
/// state, not design — nor `ApiFailure`. A screen imports those from their
/// own layers, which keeps the dependency direction honest.
library;

export 'ds_components.dart';
export 'ds_states.dart';
export 'ds_tokens.dart';
