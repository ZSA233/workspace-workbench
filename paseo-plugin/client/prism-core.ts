import "./prism-environment";
import Prism from "prismjs/components/prism-core";

// Grammar packages expect a global Prism. Native plugin evaluators may expose
// a window shim that is not the actual global object; normalize that boundary
// before evaluating any grammar (without importing browser highlight plugins).
(globalThis as unknown as { Prism: typeof Prism }).Prism = Prism;
export default Prism;
