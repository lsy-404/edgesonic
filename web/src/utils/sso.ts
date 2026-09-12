export function shouldAutoStartSso(input: {
  mode: "disabled" | "optional" | "required";
  available: boolean;
  loading: boolean;
  hasCallbackResult: boolean;
  hasCallbackError: boolean;
  optedOut: boolean;
}): boolean {
  return input.mode === "required"
    && input.available
    && !input.loading
    && !input.hasCallbackResult
    && !input.hasCallbackError
    && !input.optedOut;
}
