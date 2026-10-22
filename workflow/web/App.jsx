import { AppStateProvider } from "./app-state";
import WorkflowList from "./components/WorkflowList";

export default function App() {
  return (
    <AppStateProvider>
      <h1>ai-crawler</h1>

      <WorkflowList />
    </AppStateProvider>
  );
}
