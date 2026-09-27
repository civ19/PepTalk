import { createContext, useContext } from "react";

export interface AccountAuth {
  configured: boolean;
  loading: boolean;
  subject: string | null;
  name: string;
  email: string;
  picture: string;
  error: string | null;
  signIn: (google?: boolean) => Promise<void>;
  signOut: () => void;
  getToken: () => Promise<string>;
}

export const unconfigured: AccountAuth = {
  configured: false,
  loading: false,
  subject: null,
  name: "",
  email: "",
  picture: "",
  error: null,
  signIn: async () => {},
  signOut: () => {},
  getToken: async () => "",
};

export const Context = createContext<AccountAuth>(unconfigured);
export const useAccountAuth = () => useContext(Context);
