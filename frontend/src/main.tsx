import ReactDOM from "react-dom/client";
import { Auth0Provider } from "@auth0/auth0-react";
import App from "./App";
import { Auth0Gate } from "./auth/Auth0Gate";

const domain = import.meta.env.VITE_AUTH0_DOMAIN?.trim();
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID?.trim();

const app =
  domain && clientId ? (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{ redirect_uri: window.location.origin }}
    >
      <Auth0Gate />
    </Auth0Provider>
  ) : (
    <App />
  );

ReactDOM.createRoot(document.getElementById("root")!).render(app);
