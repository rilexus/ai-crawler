import { createContext, useContext, useState } from "react";

const AppStateContext = createContext(null);

export function AppStateProvider({ children }) {
  const [url, setUrl] = useState("");
  return (
    <AppStateContext.Provider value={{ url, setUrl }}>
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  const state = useContext(AppStateContext);
  if (!state)
    throw new Error("useAppState must be used inside AppStateProvider");
  return state;
}
