import { useAuth0 } from "@auth0/auth0-react";
import App from "../App";

export interface AuthUiState {
  displayName: string;
  email?: string;
  picture?: string;
  logout: () => void;
}

export function Auth0Gate() {
  const { error, isAuthenticated, isLoading, loginWithRedirect, logout, user } =
    useAuth0();

  if (isLoading) {
    return (
      <main className="auth-screen">
        <section className="auth-panel" aria-live="polite">
          <span className="eyebrow">PREPTALK</span>
          <h1>Checking your account</h1>
        </section>
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="auth-screen">
        <section className="auth-panel">
          <span className="eyebrow">PREPTALK</span>
          <h1>Welcome back</h1>
          <p>Sign in to continue to your practice space.</p>
          {error && <p className="auth-error">{error.message}</p>}
          <button
            className="button button-primary"
            type="button"
            onClick={() => void loginWithRedirect()}
          >
            Log in with Auth0
          </button>
          <button
            className="button button-outline"
            type="button"
            onClick={() =>
              void loginWithRedirect({
                authorizationParams: { screen_hint: "signup" },
              })
            }
          >
            Create an account
          </button>
        </section>
      </main>
    );
  }

  const auth: AuthUiState = {
    displayName: user?.name || user?.email || "PrepTalk member",
    email: user?.email,
    picture: user?.picture,
    logout: () => {
      void logout({ logoutParams: { returnTo: window.location.origin } });
    },
  };

  return <App auth={auth} />;
}
