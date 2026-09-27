import ReactDOM from "react-dom/client";
import { Auth0Provider } from "@auth0/auth0-react";
import App from "./App";
import { Auth0Gate } from "./auth/Auth0Gate";

const domain =
  import.meta.env.VITE_AUTH0_DOMAIN?.trim() ||
  "dev-wijcepqixl75fe1o.us.auth0.com";
const clientId =
  import.meta.env.VITE_AUTH0_CLIENT_ID?.trim() ||
  "IABg9tufn4oWH5EjyLUm3L36wKr6l9WE";

const app = (
  <Auth0Provider
    domain={domain}
    clientId={clientId}
    authorizationParams={{ redirect_uri: window.location.origin }}
  >
    <Auth0Gate />
  </Auth0Provider>
);

ReactDOM.createRoot(document.getElementById("root")!).render(app);
