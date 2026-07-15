const ROUTES = { "/health": () => "ok" };
const METHODS = new Set(["GET"]);
export function handle(method, path) {
	if (!METHODS.has(method)) return "405";
	const h = ROUTES[path];
	return h ? h() : "404";
}
