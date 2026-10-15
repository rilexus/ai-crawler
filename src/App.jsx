import { AppStateProvider, useAppState } from "./app-state";

function UrlInput() {
  const { url, setUrl } = useAppState();
  return (
    <label>
      Page URL{" "}
      <input
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://example.com"
      />
    </label>
  );
}

function UrlPreview() {
  const { url } = useAppState();
  return <p>{url ? `Target: ${url}` : "No URL set."}</p>;
}

export default function App() {
  return (
    <AppStateProvider>
      <h1>ai-crawler</h1>
      <UrlInput />
      <UrlPreview />
    </AppStateProvider>
  );
}
