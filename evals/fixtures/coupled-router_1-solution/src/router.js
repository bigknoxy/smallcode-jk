const ROUTES = { "/health": () => "ok", "/submit": () => "created" };
const METHODS = new Set(["GET", "POST"]);
export function handle(method, path) {
	if (!METHODS.has(method)) return "405";
	const h = ROUTES[path];
	return h ? h() : "404";
}
