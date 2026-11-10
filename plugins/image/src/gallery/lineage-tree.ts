/**
 * 把一张图的一家子排成画廊画来历的样子：一列图，加上图之间的线。
 *
 * 从上往下读成一个故事——狗，然后是帽子，然后是抱着它的女孩。不管一家子长什么形状，图都留在同一列：
 * 把分支往旁边挪，列就会左右折，旁边的字每一行都从不同的地方起头。分支改由线来说：
 *
 * - 紧跟在原图下面的那次修改，用一根短直线挂在原图上。
 * - 其余的线——同一张图的第二次修改、用两张图画的一张——从图的左边出来，沿着列旁边的槽往下走，再拐进它画出的那张。
 *
 * 每条分支整条列完再列下一条，所以大多数线都是直的：一张图的第一次修改紧跟在它后面，从那次修改再改出来的，都排在它的第二次修改前面。
 */

export interface FamilyNode {
	id: string;
	at: number;
	/** 一次调用里画的几张一起到，按这个排。 */
	index?: number;
	parents: readonly string[];
}

const byTime = (a: FamilyNode, b: FamilyNode) => a.at - b.at || (a.index ?? 0) - (b.index ?? 0) || a.id.localeCompare(b.id);

/** 一张图从哪些图来、又改出了哪些图，连得上的一家子，最早的在前。 */
export function familyOf(id: string, nodes: ReadonlyMap<string, FamilyNode>): FamilyNode[] {
	const start = nodes.get(id);
	if (!start) return [];
	const children = new Map<string, string[]>();
	for (const node of nodes.values()) {
		for (const parent of node.parents) {
			const list = children.get(parent);
			if (list) list.push(node.id);
			else children.set(parent, [node.id]);
		}
	}
	const seen = new Set([id]);
	const queue = [id];
	while (queue.length) {
		const current = queue.pop() as string;
		for (const next of [...(nodes.get(current)?.parents ?? []), ...(children.get(current) ?? [])]) {
			if (seen.has(next) || !nodes.has(next)) continue;
			seen.add(next);
			queue.push(next);
		}
	}
	return [...seen].map((member) => nodes.get(member) as FamilyNode).sort(byTime);
}

export interface TreeLink {
	/** 原图所在的行和改出来那张所在的行；总是往下。 */
	from: number;
	to: number;
	/** 走槽里的第几道，从列往外数；两行挨着、画成直线时是 null。 */
	lane: number | null;
	/** 是正在看的那张图来路上的一段。 */
	onPath: boolean;
}

export interface LineageTree {
	order: FamilyNode[];
	links: TreeLink[];
	/** 线一共要几道槽；没有分支的一家子是 0。 */
	lanes: number;
}

/**
 * 给定正在看哪一张，一家子的行和线。
 *
 * 次序是从最早的图出发、一条分支一条分支往下走，先改的在前。用两张图画的一张，要等两张都列出来才列，
 * 所以没有往上走的线——时间顺着列往下。
 */
export function lineageTree(family: readonly FamilyNode[], current: string): LineageTree {
	const members = new Map(family.map((node) => [node.id, node]));
	const parentsOf = (node: FamilyNode) => [...new Set(node.parents)].filter((parent) => members.has(parent));
	const children = new Map<string, FamilyNode[]>();
	for (const node of family) {
		for (const parent of parentsOf(node)) {
			const list = children.get(parent);
			if (list) list.push(node);
			else children.set(parent, [node]);
		}
	}
	for (const list of children.values()) list.sort(byTime);

	const order: FamilyNode[] = [];
	const seen = new Set<string>();
	const visit = (start: FamilyNode) => {
		// 显式的栈：一段很长的来历用递归会很深。子节点倒着压栈，最早的修改先走。
		const stack = [start];
		while (stack.length) {
			const node = stack.pop() as FamilyNode;
			if (seen.has(node.id)) continue;
			seen.add(node.id);
			order.push(node);
			const ready = (children.get(node.id) ?? []).filter((child) => !seen.has(child.id) && parentsOf(child).every((parent) => seen.has(parent)));
			stack.push(...ready.reverse());
		}
	};
	for (const node of [...family].sort(byTime)) if (parentsOf(node).length === 0) visit(node);
	// 只有带环的一家子会走到这里，记下的来源造不出环；列出来，而不是丢掉。
	for (const node of [...family].sort(byTime)) visit(node);

	const row = new Map(order.map((node, at) => [node.id, at]));
	const path = new Set<string>();
	const climb = [current];
	while (climb.length) {
		const id = climb.pop() as string;
		if (path.has(id) || !members.has(id)) continue;
		path.add(id);
		climb.push(...parentsOf(members.get(id) as FamilyNode));
	}

	const links: TreeLink[] = [];
	for (const node of order) {
		for (const parent of parentsOf(node)) {
			const from = row.get(parent) as number;
			const to = row.get(node.id) as number;
			links.push({ from: Math.min(from, to), to: Math.max(from, to), lane: null, onPath: path.has(parent) && path.has(node.id) });
		}
	}

	// 走不了直线的，在它跨过的所有行上（两头也算）取最近的一道空槽：两根线不共用一段槽，也不共用拐进图的那一小截。
	const taken: { from: number; to: number }[][] = [];
	const bent = links.filter((link) => link.to !== link.from + 1).sort((a, b) => a.from - b.from || a.to - b.to);
	for (const link of bent) {
		let lane = taken.findIndex((spans) => spans.every((span) => span.to < link.from || span.from > link.to));
		if (lane === -1) lane = taken.push([]) - 1;
		taken[lane]?.push({ from: link.from, to: link.to });
		link.lane = lane;
	}
	return { order, links, lanes: taken.length };
}
