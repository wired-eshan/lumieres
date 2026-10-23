/**
 * Report of anything unusual found while loading or importing a document.
 *
 * Over-limit notes are the important case: their text is preserved exactly as
 * stored (never truncated) and the banner explains that they simply cannot grow
 * until trimmed.
 */

import { type ReactNode } from 'react';
import type { ValidationIssue } from '../../graph/graphValidation';
import { MAX_NODE_CONTENT_LENGTH } from '../../config';
import { formatCount } from '../../utils/misc';
import { CloseIcon } from '../icons';

export interface IssueBannerProps {
  issues: ValidationIssue[];
  notes: string[];
  onDismiss: () => void;
  onFocusNode: (nodeId: string) => void;
}

export function IssueBanner({ issues, notes, onDismiss, onFocusNode }: IssueBannerProps): ReactNode {
  if (issues.length === 0 && notes.length === 0) return null;

  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  return (
    <div className="issue-banner" data-overlay="true" role="status">
      <div className="issue-banner__content">
        <strong className="issue-banner__headline">
          {errors.length > 0
            ? `${formatCount(errors.length)} problem${errors.length === 1 ? '' : 's'} found in this document`
            : `${formatCount(warnings.length)} note${warnings.length === 1 ? '' : 's'} need${warnings.length === 1 ? 's' : ''} attention`}
        </strong>
        <ul className="issue-banner__list">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
          {[...errors, ...warnings].slice(0, 4).map((issue, index) => (
            <li key={`${issue.code}-${issue.nodeId ?? index}`} className={issue.severity === 'warning' ? 'is-warning' : ''}>
              {issue.message}
              {issue.nodeId ? (
                <button type="button" className="link-button" onClick={() => onFocusNode(issue.nodeId as string)}>
                  Show note
                </button>
              ) : null}
            </li>
          ))}
          {issues.length > 4 ? <li>…and {formatCount(issues.length - 4)} more.</li> : null}
        </ul>
        {warnings.some((issue) => issue.code === 'CONTENT_LIMIT_EXCEEDED') ? (
          <p className="issue-banner__footnote">
            Over-limit notes keep all of their text — nothing was truncated on load. They cannot grow
            until they are trimmed back under {formatCount(MAX_NODE_CONTENT_LENGTH)} characters.
          </p>
        ) : null}
      </div>
      <button type="button" className="icon-button is-small" onClick={onDismiss} aria-label="Dismiss report">
        <CloseIcon size={13} />
      </button>
    </div>
  );
}
