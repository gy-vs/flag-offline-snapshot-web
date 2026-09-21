import {useCallback, useRef, useState} from 'react';
import {GenerationGate, type GenerationResult} from '../../shared/generation';

export type GateState<T> =
  | {status: 'idle'}
  | {status: 'running'}
  | {status: 'completed'; value: T}
  | {status: 'cancelled'}
  | {status: 'superseded'}
  | {status: 'failed'; error: string};

/**
 * React binding for GenerationGate.
 *
 * begin() invalidates any previous selection: the gate marks the older
 * generation as superseded and its result never reaches state, so an old
 * generation task cannot overwrite a newer selection.
 */
export function useGeneration<T>() {
  const gateRef = useRef<GenerationGate | null>(null);
  if (!gateRef.current) gateRef.current = new GenerationGate();
  const [state, setState] = useState<GateState<T>>({status: 'idle'});

  const run = useCallback(async (producer: (signal: AbortSignal) => Promise<T>) => {
    const gate = gateRef.current!;
    const {generation, signal} = gate.begin();
    setState({status: 'running'});
    const result: GenerationResult<T> = await gate.run(generation, signal, producer);
    if (result.status === 'completed') setState({status: 'completed', value: result.value});
    else if (result.status === 'cancelled') setState({status: 'cancelled'});
    else if (result.status === 'superseded') setState({status: 'superseded'});
    return result;
  }, []);

  const cancel = useCallback(() => gateRef.current!.cancel(), []);
  const reset = useCallback(() => setState({status: 'idle'}), []);

  return {state, run, cancel, reset, gate: gateRef.current!};
}
