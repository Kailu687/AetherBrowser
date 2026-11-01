/** Wraps one uBO scriptlet so its declarations stay local and its errors stay contained. */
export const isolateScriptlet = (code: string): string => `(function(){try{\n${code}\n}catch(e){}})();`;
