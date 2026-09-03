declare global {
  interface Window {
    turnstile?: {
      render(container: HTMLElement, options: {
        sitekey: string;
        action: string;
        callback: (token: string) => void;
        "expired-callback": () => void;
        "error-callback": () => void;
      }): string;
      remove(widgetId: string): void;
    };
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Turnstile failed to load"));
    document.head.append(script);
  });
  return scriptPromise;
}

export async function renderTurnstile(
  container: HTMLElement,
  siteKey: string,
  action: "login" | "register",
  onToken: (token: string) => void,
): Promise<string | null> {
  await loadTurnstile();
  if (!window.turnstile) return null;
  return window.turnstile.render(container, {
    sitekey: siteKey,
    action,
    callback: onToken,
    "expired-callback": () => onToken(""),
    "error-callback": () => onToken(""),
  });
}

export function removeTurnstile(widgetId: string | null): void {
  if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
}
