import type { ReactNode } from "react";
import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { Context, unconfigured, type AccountAuth } from "./context";

function AuthBridge({ children }: { children: ReactNode }) {
  const {
    user,
    isAuthenticated,
    isLoading,
    error,
    loginWithRedirect,
    logout,
    getAccessTokenSilently,
  } = useAuth0();
  const value: AccountAuth = {
    configured: true,
    loading: isLoading,
    subject: isAuthenticated ? (user?.sub ?? null) : null,
    name: user?.name ?? user?.nickname ?? "",
    email: user?.email ?? "",
    picture: user?.picture ?? "",
    error: error
      ? /service not found/i.test(error.message)
        ? "Auth0 rejected the API audience. In Auth0 Dashboard → Applications → APIs, create or select an API and copy its exact Identifier into AUTH0_AUDIENCE and VITE_AUTH0_AUDIENCE. Restart both servers."
        : `Sign in failed: ${error.message}`
      : null,
    signIn: async (google = false) => {
      await loginWithRedirect({
        authorizationParams: google ? { connection: "google-oauth2" } : {},
      });
    },
    signOut: () =>
      logout({ logoutParams: { returnTo: window.location.origin } }),
    getToken: async () => {
      const token = await getAccessTokenSilently();
      if (!token) throw new Error("Auth0 did not return an access token.");
      return token;
    },
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export default function AccountAuthProvider({
  children,
}: {
  children: ReactNode;
}) {
  const domain = import.meta.env.VITE_AUTH0_DOMAIN?.trim();
  const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID?.trim();
  const audience = import.meta.env.VITE_AUTH0_AUDIENCE?.trim();
  if (!domain || !clientId || !audience)
    return <Context.Provider value={unconfigured}>{children}</Context.Provider>;
  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience,
        scope: "openid profile email",
      }}
    >
      <AuthBridge>{children}</AuthBridge>
    </Auth0Provider>
  );
}
