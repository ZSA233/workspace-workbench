import { useEffect, type RefObject } from 'react';
import { Platform } from 'react-native';
export function useDiffCodeCopy(copyRoot: RefObject<any>) {
    useEffect(() => {
        if (Platform.OS !== 'web')
            return;
        const document = (globalThis as any).document;
        if (!document)
            return;
        const copy = (event: any) => {
            const selection = document.getSelection();
            if (!selection?.rangeCount || selection.isCollapsed || !copyRoot.current?.contains(selection.anchorNode))
                return;
            const anchor = selection.anchorNode?.nodeType === 1 ? selection.anchorNode : selection.anchorNode?.parentElement;
            const side = anchor?.closest('[data-testid^="diff-code-"]')?.getAttribute('data-testid');
            if (!side)
                return;
            const range = selection.getRangeAt(0), parts: string[] = [];
            for (const node of copyRoot.current.querySelectorAll('[data-testid^="diff-code-"]')) {
                if (node.getAttribute('data-testid') !== side || !range.intersectsNode(node))
                    continue;
                const part = document.createRange();
                part.selectNodeContents(node);
                if (range.compareBoundaryPoints(0, part) > 0)
                    part.setStart(range.startContainer, range.startOffset);
                if (range.compareBoundaryPoints(2, part) < 0)
                    part.setEnd(range.endContainer, range.endOffset);
                parts.push(part.toString());
            }
            if (parts.length && event.clipboardData) {
                event.clipboardData.setData('text/plain', parts.join('\n'));
                event.preventDefault();
            }
        };
        document.addEventListener('copy', copy);
        return () => document.removeEventListener('copy', copy);
    }, []);
}
