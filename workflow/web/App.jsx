import { AppStateProvider } from "./app-state";
import WorkflowList from "./components/WorkflowList";
import { GlobalStyle } from "./global-styles";

export default function App() {
  return (
    <AppStateProvider>
      <GlobalStyle />
      <h1>ai-crawler</h1>

      <WorkflowList />
    </AppStateProvider>
  );
}
