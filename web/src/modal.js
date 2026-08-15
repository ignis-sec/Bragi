// Tiny modal bus: any component can call openModal() without prop drilling;
// the single ModalHost in App renders whatever was requested.
let listener = null;

export function openModal(modal) {
  listener?.(modal);
}

export function setModalListener(fn) {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}
