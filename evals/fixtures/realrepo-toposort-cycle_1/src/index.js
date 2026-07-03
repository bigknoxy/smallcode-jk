import { runToposort } from "./graph.js";

/**
 * Topologically sort a dependency graph given as an array of [from, to]
 * edges, where an edge [from, to] means "from" depends on "to".
 *
 * Returns an array ordered so that every dependency appears before the
 * node(s) that depend on it.
 */
export default function toposort(edges) {
  var nodes = new Set();
  var adjacency = new Map();

  for (var i = 0; i < edges.length; i++) {
    var from = edges[i][0];
    var to = edges[i][1];
    nodes.add(from);
    nodes.add(to);
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push(to);
  }

  return runToposort(nodes, adjacency);
}
