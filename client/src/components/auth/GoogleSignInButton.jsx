import { useEffect, useRef } from "react";

// Renders Google's own "Sign in with Google" button via their Identity
// Services script, and hands the resulting ID token up to the caller -
// the caller decides what to do with it (login vs register have slightly
// different post-success flows).
export default function GoogleSignInButton({ onCredential }) {
  const buttonRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const renderButton = () => {
      if (cancelled || !buttonRef.current || !window.google) return;

      window.google.accounts.id.initialize({
        client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
        callback: (response) => onCredential(response.credential),
      });

      window.google.accounts.id.renderButton(buttonRef.current, {
        theme: "filled_black",
        size: "large",
        text: "continue_with",
        width: 360,
      });
    };

    if (window.google?.accounts?.id) {
      renderButton();
    } else {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.onload = renderButton;
      document.body.appendChild(script);
    }

    return () => {
      cancelled = true;
    };
  }, [onCredential]);

  return <div ref={buttonRef} className="flex justify-center" />;
}
