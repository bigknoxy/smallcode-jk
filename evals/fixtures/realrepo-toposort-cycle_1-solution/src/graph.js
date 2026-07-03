/**
 * Depth-first visit of a node's dependencies, recording nodes into `result`
 * in dependency-first (post-order) order.
 */
function visit(node, adjacency, visited, result) {
  if (visited.has(node)) return;
  visited.add(node);

  var deps = adjacency.get(node) || [];
  for (var i = 0; i < deps.length; i++) {
    visit(deps[i], adjacency, visited, result);
  }

  // FIX: push the node only after all of its dependencies have been
  // visited, so dependencies always precede the nodes that depend on them.
  result.push(node);
}

/**
 * Runs a DFS-based topological sort over `nodes` using the `adjacency`
 * map (node -> array of dependency nodes). Returns nodes ordered so that
 * every dependency precedes the node(s) that depend on it.
 */
export function runToposort(nodes, adjacency) {
  var visited = new Set();
  var result = [];

  for (var node of nodes) {
    visit(node, adjacency, visited, result);
  }

  return result;
}
