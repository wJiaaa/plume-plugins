/** 只更新变动的节点，保留已有元素，避免流式输入时重建整页而闪烁。 */
export function morph(target: Element, source: Element): void {
	syncAttributes(target, source);
	morphChildren(target, source);
}

function morphChildren(target: Node, source: Node): void {
	const document = target.ownerDocument ?? (target as Document);
	const wanted = source.childNodes;
	for (let index = 0; index < wanted.length; index++) {
		const next = wanted[index]!;
		const have = target.childNodes[index];
		if (!have) {
			target.appendChild(document.importNode(next, true));
			continue;
		}
		if (have.nodeType !== next.nodeType || have.nodeName !== next.nodeName) {
			target.replaceChild(document.importNode(next, true), have);
			continue;
		}
		if (next.nodeType === 1) morph(have as Element, next as Element);
		else if (have.nodeValue !== next.nodeValue) have.nodeValue = next.nodeValue;
	}
	while (target.childNodes.length > wanted.length) target.lastChild!.remove();
}

function syncAttributes(target: Element, source: Element): void {
	for (const attribute of Array.from(target.attributes)) {
		if (!source.hasAttributeNS(attribute.namespaceURI, attribute.localName)) target.removeAttributeNS(attribute.namespaceURI, attribute.localName);
	}
	for (const attribute of source.attributes) {
		if (target.getAttributeNS(attribute.namespaceURI, attribute.localName) !== attribute.value)
			target.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
	}
}
