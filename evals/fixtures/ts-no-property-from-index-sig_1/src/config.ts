interface Env {
  [key: string]: string;
}

function getHost(env: Env): string {
  return env["HOST"];
}
