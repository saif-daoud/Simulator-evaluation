window.SIMULATOR_EVAL_CONFIG = {
  apiBase: ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? "http://127.0.0.1:8787"
    : "https://cbt-simulator-evaluation-api.saif-sedaoud.workers.dev"
};
