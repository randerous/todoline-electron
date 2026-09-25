/** Build the first editor in its existing, temporarily detached host. Chromium's
 * getSelection() can otherwise force a full document layout during plugin setup.
 * Keep the scroller hierarchy (used by plugins), restoring it synchronously even
 * on failure. This is only used before the editor has focus or mounted content. */
export function initialLayout<T>(element:HTMLElement,initialize:()=>T):T {
  const host=element.closest('.document-scroller')??element,parent=host.parentNode;
  if(!parent||!host.isConnected)return initialize();
  const marker=host.ownerDocument.createComment('editor initialization');
  parent.replaceChild(marker,host);
  try{return initialize();}finally{parent.replaceChild(host,marker);}
}
