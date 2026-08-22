import { useQuery } from '@tanstack/react-query';

import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { AsyncBoundary } from '../../../shared/components/AsyncState';
import { platformOpsApi } from '../api/platformOpsApi';

/**
 * ===========================================================================
 * IS THE PLATFORM WORKING — the screen whose absence cost a whole day.
 * ===========================================================================
 *
 * On 2026-08-21 the only way to answer that question was to open Railway and
 * read container logs. The facts were all available over HTTP the whole time —
 * `/system/readiness` names every dependency and why it is or is not ready,
 * `/system/diagnostics` names the build and, since this sprint, the SCHEMA the
 * build is running on. Nothing displayed them.
 *
 * THE SCHEMA ROW IS THE ONE THAT MATTERS MOST, and it is the one no other
 * health check in this system can give. `/health/ready` asks whether Postgres
 * answers `SELECT 1`, which a database thirty migrations behind answers just as
 * cheerfully — that is exactly how a container ran for three days on a schema
 * its code did not expect. `schema.appliedCount` and `schema.latestName` come
 * from `_prisma_migrations` on every call, so this row is a measurement of the
 * live database and not a claim by the image.
 */
export function PlatformHealthPage() {
  const { t } = useTranslation();

  const readiness = useQuery({ queryKey: ['platform-readiness'], queryFn: platformOpsApi.readiness });
  const diagnostics = useQuery({ queryKey: ['platform-diagnostics'], queryFn: platformOpsApi.diagnostics });

  const schema = diagnostics.data?.schema;

  return (
    <section>
      <header>
        <h1>{t('health.title')}</h1>
        <p>{t('health.intro')}</p>
      </header>

      <AsyncBoundary
        isLoading={diagnostics.isLoading}
        error={diagnostics.isError ? (diagnostics.error as Error) : null}
        onRetry={() => diagnostics.refetch()}
      >
        <section>
          <h2>{t('health.build')}</h2>
          <dl>
            <dt>{t('health.environment')}</dt>
            <dd>{diagnostics.data?.environment}</dd>
            <dt>{t('health.version')}</dt>
            <dd>{diagnostics.data?.version}</dd>
            <dt>{t('health.commit')}</dt>
            {/* `null` is the honest answer for an unstamped build and is shown
                as such: an empty string here would read as "the sha is blank". */}
            <dd>{diagnostics.data?.commit ?? t('health.commitUnknown')}</dd>
            <dt>{t('health.uptime')}</dt>
            <dd>
              {diagnostics.data ? Math.floor(diagnostics.data.uptimeSeconds / 3600) : 0} {t('health.hours')}
            </dd>
          </dl>
        </section>

        <section>
          <h2>{t('health.schema')}</h2>
          {!schema ? (
            <p>{t('health.schemaUnsupported')}</p>
          ) : !schema.available ? (
            <p role="alert">
              {t('health.schemaNoLedger')} {schema.reason ? `— ${schema.reason}` : ''}
            </p>
          ) : (
            <>
              <p>
                {schema.appliedCount} {t('health.migrationsApplied')} · {schema.latestName}
              </p>
              {schema.unfinishedCount > 0 ? (
                // Half-migrated is a different and worse state than behind, so
                // it gets its own alert rather than a smaller number.
                <p role="alert">
                  {t('health.schemaHalfMigrated')}: {schema.unfinishedNames.join(', ')}
                </p>
              ) : null}
            </>
          )}
        </section>

        <section>
          <h2>{t('health.config')}</h2>
          <p>
            {diagnostics.data?.configValidation.warningCount ?? 0} {t('health.warnings')}
          </p>
          <ul>
            {(diagnostics.data?.configValidation.warningKeys ?? []).map((key) => (
              <li key={key}>{key}</li>
            ))}
          </ul>
        </section>
      </AsyncBoundary>

      <h2>{t('health.dependencies')}</h2>
      <AsyncBoundary
        isLoading={readiness.isLoading}
        error={readiness.isError ? (readiness.error as Error) : null}
        isEmpty={!readiness.isLoading && !readiness.isError && (readiness.data?.components.length ?? 0) === 0}
        emptyHint={t('health.noComponents')}
        onRetry={() => readiness.refetch()}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">{t('health.component')}</th>
              <th scope="col">{t('health.status')}</th>
              <th scope="col">{t('health.detail')}</th>
            </tr>
          </thead>
          <tbody>
            {(readiness.data?.components ?? []).map((component) => (
              <tr key={component.component}>
                <td>{component.component}</td>
                <td>{component.status}</td>
                {/* NOT_APPLICABLE is shown with its reason rather than hidden:
                    "no push provider is integrated" is a fact an owner needs,
                    and a blank row would read as healthy. */}
                <td>{component.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </AsyncBoundary>
    </section>
  );
}
