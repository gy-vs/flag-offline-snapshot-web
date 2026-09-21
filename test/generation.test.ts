import {describe,expect,it} from 'vitest';
import {createTaskGate} from '../src/client/generation';

describe('task gate (generation cancellation / stale protection)',()=>{
  it('only the newest generation stays current',()=>{
    const gate=createTaskGate();
    const first=gate.begin();
    expect(gate.isCurrent(first)).toBe(true);
    const second=gate.begin(); // user changed the selection and started a new generation
    expect(gate.isCurrent(first)).toBe(false); // stale task must not overwrite the new selection
    expect(gate.isCurrent(second)).toBe(true);
  });
  it('invalidate revokes in-flight tasks (cancel)',()=>{
    const gate=createTaskGate();
    const token=gate.begin();
    gate.invalidate();
    expect(gate.isCurrent(token)).toBe(false);
    const next=gate.begin();
    expect(gate.isCurrent(next)).toBe(true);
  });
});
