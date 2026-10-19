# runner app

Future runner process/daemon entry point.

Reusable runner contracts and the V0 `LocalRunner` implementation live in `@control-plane/runner`. This app boundary is reserved for a later remote runner daemon so process supervision can move to other machines without changing the control-plane domain or runner interface.
