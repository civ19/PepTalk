import ReactDOM from "react-dom/client";
import App from "./App";
import AccountAuthProvider from "./auth/AuthProvider";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <AccountAuthProvider>
    <App />
  </AccountAuthProvider>,
);
