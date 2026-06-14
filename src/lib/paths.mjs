export const GANTRY_DIR = '.gantry';
export const PLANNING_DIR = `${GANTRY_DIR}/planning`;
export const SPECS_DIR = `${GANTRY_DIR}/specs`;

export function planningPath(...parts) {
  return [PLANNING_DIR, ...parts].join('/');
}

export function specsPath(...parts) {
  return [SPECS_DIR, ...parts].join('/');
}
