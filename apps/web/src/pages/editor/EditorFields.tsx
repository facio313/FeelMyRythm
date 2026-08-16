import {
  type JumpDirective,
  type TempoMap,
  type TempoMapValidationIssue,
  type VoltaEnding,
} from '@feelmyrythm/core';
import { Button, Field } from '@feelmyrythm/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useId, type ChangeEvent, type ComponentProps, type ReactNode } from 'react';
import { JUMP_LABELS, issueFor } from './tempoMapEdits';

type EditorFieldProps = Omit<ComponentProps<typeof Field>, 'error'> & {
  error?: string | undefined;
};

export function EditorField({ error, ...props }: EditorFieldProps) {
  return <Field {...props} {...(error ? { error } : {})} />;
}

export function SelectField({
  label,
  value,
  onChange,
  error,
  children,
  ariaLabel,
}: {
  label: string;
  value: string | number;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  error?: string | undefined;
  children: ReactNode;
  ariaLabel?: string;
}) {
  const generatedId = useId();
  const id = `editor-select-${generatedId.replaceAll(':', '')}`;
  const descriptionId = error ? `${id}-error` : undefined;
  return (
    <label className="fmr-field" htmlFor={id}>
      <span className="fmr-field__label">{label}</span>
      <select
        id={id}
        className={error ? 'fmr-input fmr-input--error' : 'fmr-input'}
        value={value}
        onChange={onChange}
        aria-label={ariaLabel}
        aria-invalid={Boolean(error)}
        aria-describedby={descriptionId}
      >
        {children}
      </select>
      {error ? (
        <span id={descriptionId} className="fmr-field__hint fmr-field__error">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="editor-checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}

export function JumpFields({
  jump,
  index,
  map,
  issues,
  onChange,
}: {
  jump: JumpDirective;
  index: number;
  map: TempoMap;
  issues: readonly TempoMapValidationIssue[];
  onChange: (jump: JumpDirective) => void;
}) {
  const path = `jumps[${index}]`;
  if (jump.type === 'repeat') {
    const endings = jump.endings ?? [];
    const updateEnding = (endingIndex: number, next: VoltaEnding) => {
      const nextEndings = endings.map((ending, current) =>
        current === endingIndex ? next : ending,
      );
      onChange({ ...jump, endings: nextEndings });
    };
    const addEnding = () => {
      const usedPasses = new Set(endings.flatMap((ending) => ending.forPass));
      const pass = Array.from({ length: jump.times }, (_, item) => item + 1).find(
        (item) => !usedPasses.has(item),
      );
      const offset = Math.min(endings.length, jump.endMeasure - jump.startMeasure);
      onChange({
        ...jump,
        endings: [
          ...endings,
          {
            measures: [jump.endMeasure - offset, jump.endMeasure - offset],
            forPass: [pass ?? 1],
          },
        ],
      });
    };
    return (
      <>
        <div className="jump-field-grid">
          <EditorField
            label="반복 시작 마디"
            type="number"
            min={1}
            max={map.totalMeasures}
            value={jump.startMeasure}
            error={issueFor(issues, `${path}.startMeasure`)}
            onChange={(event) => onChange({ ...jump, startMeasure: Number(event.target.value) })}
          />
          <EditorField
            label="반복 끝 마디"
            type="number"
            min={jump.startMeasure}
            max={map.totalMeasures}
            value={jump.endMeasure}
            error={issueFor(issues, `${path}.endMeasure`)}
            onChange={(event) => onChange({ ...jump, endMeasure: Number(event.target.value) })}
          />
          <EditorField
            label="총 연주 횟수"
            type="number"
            min={1}
            max={8}
            value={jump.times}
            error={issueFor(issues, `${path}.times`)}
            onChange={(event) => {
              const times = Number(event.target.value);
              onChange({
                ...jump,
                times,
                ...(jump.endings
                  ? {
                      endings: jump.endings.map((ending) => ({
                        ...ending,
                        forPass: ending.forPass.filter((pass) => pass <= times),
                      })),
                    }
                  : {}),
              });
            }}
          />
        </div>
        <div className="volta-editor">
          <div className="volta-editor__header">
            <div>
              <strong>1st / 2nd ending</strong>
              <p>엔딩 마디와 이 엔딩을 연주할 패스를 선택합니다.</p>
            </div>
            <Button onClick={addEnding}>
              <Plus size={16} aria-hidden /> 볼타 엔딩 추가
            </Button>
          </div>
          {endings.length === 0 ? (
            <p className="subtle">볼타 엔딩이 없습니다.</p>
          ) : (
            endings.map((ending, endingIndex) => {
              const endingPath = `${path}.endings[${endingIndex}]`;
              return (
                <fieldset className="volta-ending" key={endingIndex}>
                  <legend>{endingIndex + 1}번 엔딩</legend>
                  <div className="jump-field-grid">
                    <EditorField
                      label="엔딩 시작 마디"
                      type="number"
                      min={jump.startMeasure}
                      max={jump.endMeasure}
                      value={ending.measures[0]}
                      error={issueFor(issues, `${endingPath}.measures`)}
                      onChange={(event) =>
                        updateEnding(endingIndex, {
                          ...ending,
                          measures: [Number(event.target.value), ending.measures[1]],
                        })
                      }
                    />
                    <EditorField
                      label="엔딩 끝 마디"
                      type="number"
                      min={ending.measures[0]}
                      max={jump.endMeasure}
                      value={ending.measures[1]}
                      error={issueFor(issues, `${endingPath}.measures`)}
                      onChange={(event) =>
                        updateEnding(endingIndex, {
                          ...ending,
                          measures: [ending.measures[0], Number(event.target.value)],
                        })
                      }
                    />
                  </div>
                  <div
                    className="pass-picker"
                    role="group"
                    aria-label={`${endingIndex + 1}번 엔딩 패스`}
                  >
                    {Array.from({ length: Math.max(0, jump.times) }, (_, passIndex) => {
                      const pass = passIndex + 1;
                      return (
                        <label key={pass}>
                          <input
                            type="checkbox"
                            checked={ending.forPass.includes(pass)}
                            onChange={(event) =>
                              updateEnding(endingIndex, {
                                ...ending,
                                forPass: event.target.checked
                                  ? [...ending.forPass, pass].sort((left, right) => left - right)
                                  : ending.forPass.filter((item) => item !== pass),
                              })
                            }
                          />
                          {pass}번째 패스
                        </label>
                      );
                    })}
                  </div>
                  {issueFor(issues, `${endingPath}.forPass`, true) ? (
                    <p className="inline-issue">
                      {issueFor(issues, `${endingPath}.forPass`, true)}
                    </p>
                  ) : null}
                  <Button
                    variant="ghost"
                    onClick={() =>
                      onChange({
                        ...jump,
                        endings: endings.filter((_, current) => current !== endingIndex),
                      })
                    }
                  >
                    <Trash2 size={16} aria-hidden /> 엔딩 삭제
                  </Button>
                </fieldset>
              );
            })
          )}
          {issueFor(issues, `${path}.endings`, true) ? (
            <p className="inline-issue">{issueFor(issues, `${path}.endings`, true)}</p>
          ) : null}
        </div>
      </>
    );
  }

  if (jump.type === 'dc' || jump.type === 'ds') {
    return (
      <>
        <div className="jump-field-grid">
          <EditorField
            label={`${JUMP_LABELS[jump.type]} 실행 마디`}
            type="number"
            min={1}
            max={map.totalMeasures}
            value={jump.atMeasure}
            error={issueFor(issues, `${path}.atMeasure`)}
            onChange={(event) => onChange({ ...jump, atMeasure: Number(event.target.value) })}
          />
          {jump.type === 'ds' ? (
            <EditorField
              label="Segno 마디"
              type="number"
              min={1}
              max={map.totalMeasures}
              value={jump.segnoMeasure}
              error={issueFor(issues, `${path}.segnoMeasure`)}
              onChange={(event) => onChange({ ...jump, segnoMeasure: Number(event.target.value) })}
            />
          ) : null}
          {jump.alFine !== undefined ? (
            <EditorField
              label="Fine 마디"
              type="number"
              min={1}
              max={map.totalMeasures}
              value={jump.alFine}
              error={issueFor(issues, `${path}.alFine`)}
              onChange={(event) => onChange({ ...jump, alFine: Number(event.target.value) })}
            />
          ) : null}
        </div>
        <div className="jump-options">
          <CheckboxField
            label="al Fine"
            checked={jump.alFine !== undefined}
            hint="되돌아간 뒤 Fine 마디에서 끝냅니다."
            onChange={(checked) => {
              if (checked) {
                onChange({ ...jump, alFine: jump.alFine ?? map.totalMeasures });
                return;
              }
              const { alFine: _removed, ...withoutFine } = jump;
              void _removed;
              onChange(withoutFine);
            }}
          />
          <CheckboxField
            label="al Coda"
            checked={jump.alCoda === true}
            hint="별도의 To Coda·Coda 지시가 필요합니다."
            onChange={(checked) => {
              if (checked) {
                onChange({ ...jump, alCoda: true });
                return;
              }
              const { alCoda: _removed, ...withoutCoda } = jump;
              void _removed;
              onChange(withoutCoda);
            }}
          />
        </div>
      </>
    );
  }

  return (
    <div className="jump-field-grid">
      <EditorField
        label="To Coda 마디"
        type="number"
        min={1}
        max={map.totalMeasures}
        value={jump.toCodaMeasure}
        error={issueFor(issues, `${path}.toCodaMeasure`) ?? issueFor(issues, path)}
        onChange={(event) => onChange({ ...jump, toCodaMeasure: Number(event.target.value) })}
      />
      <EditorField
        label="Coda 시작 마디"
        type="number"
        min={1}
        max={map.totalMeasures}
        value={jump.codaMeasure}
        error={issueFor(issues, `${path}.codaMeasure`) ?? issueFor(issues, path)}
        onChange={(event) => onChange({ ...jump, codaMeasure: Number(event.target.value) })}
      />
    </div>
  );
}
