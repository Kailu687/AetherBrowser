/**
 * A scikit-learn script that re-creates an Epoch run outside AETHER: the same
 * cleaning steps, column handling, split and (closest equivalent) model. It is
 * a starting point for moving to Python, not a bit-exact replica: random
 * number generators differ and a few models have no exact sklearn twin.
 */
import { pyStr } from '../expr.js';
import type { Step } from '../pipeline.js';
import { pipelineToPandas } from '../pipeline.js';
import type { ExperimentConfig, TrainedArtifact } from './experiment.js';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : String(d));
const list = (xs: string[]) => `[${xs.map(pyStr).join(', ')}]`;

function modelCode(cfg: ExperimentConfig, task: 'classification' | 'regression', p: Record<string, unknown>): { imports: string; expr: string; note?: string } {
  const cls = task === 'classification';
  const cw = cls && cfg.classWeight === 'balanced' ? ', class_weight="balanced"' : '';
  const seed = num(p.seed, 42);
  switch (cfg.model) {
    case 'baseline': return cls ? { imports: 'from sklearn.dummy import DummyClassifier', expr: 'DummyClassifier(strategy="prior")' } : { imports: 'from sklearn.dummy import DummyRegressor', expr: 'DummyRegressor(strategy="mean")' };
    case 'linear': return { imports: 'from sklearn.linear_model import Ridge', expr: `Ridge(alpha=${num(p.l2, 0.001)} * len(X_train))` };
    case 'logistic': return { imports: 'from sklearn.linear_model import LogisticRegression', expr: `LogisticRegression(C=1.0 / max(${num(p.l2, 0.001)} * len(X_train), 1e-9), max_iter=${num(p.epochs, 300)}${cw})`, note: 'Epoch uses Adam; sklearn uses L-BFGS, so coefficients differ slightly.' };
    case 'knn': return { imports: `from sklearn.neighbors import ${cls ? 'KNeighborsClassifier' : 'KNeighborsRegressor'}`, expr: `${cls ? 'KNeighborsClassifier' : 'KNeighborsRegressor'}(n_neighbors=${num(p.k, 5)}, weights=${pyStr(p.weights === 'distance' ? 'distance' : 'uniform')})` };
    case 'naiveBayes': return { imports: 'from sklearn.naive_bayes import GaussianNB', expr: `GaussianNB(var_smoothing=${num(p.varSmoothing, 1e-9)})` };
    case 'tree': return { imports: `from sklearn.tree import ${cls ? 'DecisionTreeClassifier' : 'DecisionTreeRegressor'}`, expr: `${cls ? 'DecisionTreeClassifier' : 'DecisionTreeRegressor'}(max_depth=${num(p.maxDepth, 8)}, min_samples_leaf=${num(p.minSamplesLeaf, 5)}, random_state=1)` };
    case 'forest': return { imports: `from sklearn.ensemble import ${cls ? 'RandomForestClassifier' : 'RandomForestRegressor'}`, expr: `${cls ? 'RandomForestClassifier' : 'RandomForestRegressor'}(n_estimators=${num(p.trees, 100)}, max_depth=${num(p.maxDepth, 10)}, min_samples_leaf=${num(p.minSamplesLeaf, 2)}, max_features=${p.maxFeatures === 'all' ? 'None' : pyStr(p.maxFeatures === 'log2' ? 'log2' : 'sqrt')}, random_state=${seed}, n_jobs=-1${cw})` };
    case 'gbm': {
      const es = Number(p.earlyStopping) > 0;
      return { imports: `from sklearn.ensemble import ${cls ? 'HistGradientBoostingClassifier' : 'HistGradientBoostingRegressor'}`, expr: `${cls ? 'HistGradientBoostingClassifier' : 'HistGradientBoostingRegressor'}(max_iter=${num(p.rounds, 200)}, learning_rate=${num(p.learningRate, 0.1)}, max_depth=${num(p.maxDepth, 4)}, min_samples_leaf=${num(p.minSamplesLeaf, 10)}, l2_regularization=${num(p.l2, 1)}, early_stopping=${es ? 'True' : 'False'}${es ? `, n_iter_no_change=${num(p.earlyStopping, 20)}, validation_fraction=0.1` : ''}, random_state=${seed}${cw})`, note: 'sklearn has no row/column sub-sampling for HistGradientBoosting; use xgboost or lightgbm for subsample/colsample.' };
    }
    case 'mlp': {
      const es = Number(p.earlyStopping) > 0;
      const layers = String(p.hiddenLayers ?? '64,32').split(',').map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
      return { imports: `from sklearn.neural_network import ${cls ? 'MLPClassifier' : 'MLPRegressor'}`, expr: `${cls ? 'MLPClassifier' : 'MLPRegressor'}(hidden_layer_sizes=(${layers.join(', ')},), activation=${pyStr(p.activation === 'tanh' ? 'tanh' : 'relu')}, solver="adam", learning_rate_init=${num(p.learningRate, 0.001)}, batch_size=${num(p.batchSize, 64)}, max_iter=${num(p.epochs, 200)}, alpha=${num(p.l2, 1e-4)}, early_stopping=${es ? 'True' : 'False'}${es ? `, n_iter_no_change=${num(p.earlyStopping, 15)}` : ''}, random_state=${seed})`, note: cfg.classWeight === 'balanced' ? 'MLPClassifier has no class_weight; balance by resampling if needed.' : undefined };
    }
    case 'svm': return { imports: 'from sklearn.svm import LinearSVC', expr: `LinearSVC(C=${num(p.C, 1)}${cw})` };
  }
}

export function runToSklearn(cfg: ExperimentConfig, artifact: TrainedArtifact, source: { path?: string; format?: string; steps: Step[] }): string {
  const task = artifact.target.task;
  const feats = artifact.preprocessor.features;
  const numeric = feats.filter((f) => f.kind === 'numeric').map((f) => f.name);
  const categorical = feats.filter((f) => f.kind === 'categorical').map((f) => f.name);
  const text = feats.filter((f) => f.kind === 'text').map((f) => f.name);
  const m = modelCode(cfg, task, cfg.params ?? {});
  const seed = cfg.split.seed;
  const tf = cfg.split.testFraction;
  const out: string[] = [];
  out.push('# Re-creates an AETHER Epoch run with scikit-learn.', '# Results will be close but not identical: random number generators differ.');
  if (m.note) out.push(`# Note: ${m.note}`);
  out.push(pipelineToPandas(source.steps, { path: source.path, format: source.format }).trimEnd(), '');
  out.push(
    'from sklearn.compose import ColumnTransformer',
    'from sklearn.impute import SimpleImputer',
    'from sklearn.pipeline import Pipeline, make_pipeline',
    'from sklearn.preprocessing import OneHotEncoder, StandardScaler',
    ...(text.length ? ['from sklearn.feature_extraction.text import TfidfVectorizer'] : []),
    'from sklearn.model_selection import train_test_split, GroupShuffleSplit',
    `from sklearn.metrics import ${task === 'classification' ? 'accuracy_score, f1_score, classification_report' : 'mean_absolute_error, mean_squared_error, r2_score'}`,
    m.imports,
    '',
    `target = ${pyStr(artifact.target.name)}`,
    `numeric = ${list(numeric)}`,
    `categorical = ${list(categorical)}`,
    `text = ${list(text)}`,
    'df = df[df[target].notna()].copy()',
    ...text.map((c) => `df[${pyStr(c)}] = df[${pyStr(c)}].fillna("").astype(str)`),
    ...(task === 'classification' ? ['df[target] = df[target].astype(str)'] : []),
    'X, y = df[numeric + categorical + text], df[target]',
    '',
  );
  switch (cfg.split.strategy) {
    case 'group': out.push(`_g = df[${pyStr(cfg.split.groupBy ?? '')}]`, `_tr, _te = next(GroupShuffleSplit(n_splits=1, test_size=${tf}, random_state=${seed}).split(X, y, _g))`, 'X_train, X_test, y_train, y_test = X.iloc[_tr], X.iloc[_te], y.iloc[_tr], y.iloc[_te]'); break;
    case 'time': out.push(`_order = df[${pyStr(cfg.split.timeColumn ?? '')}].sort_values(kind="stable").index`, `_cut = int(len(_order) * (1 - ${tf}))`, 'X_train, X_test = X.loc[_order[:_cut]], X.loc[_order[_cut:]]', 'y_train, y_test = y.loc[_order[:_cut]], y.loc[_order[_cut:]]'); break;
    default: out.push(`X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=${tf}, random_state=${seed}${cfg.split.strategy === 'stratified' && task === 'classification' ? ', stratify=y' : ''})`);
  }
  out.push(
    '',
    'pre = ColumnTransformer([',
    `    ("num", make_pipeline(SimpleImputer(strategy="median", add_indicator=True)${cfg.scale === false ? '' : ', StandardScaler()'}), numeric),`,
    '    ("cat", OneHotEncoder(handle_unknown="infrequent_if_exist", max_categories=51), categorical),',
    ...text.map((c) => `    (${pyStr(`text:${c}`)}, TfidfVectorizer(max_features=100, min_df=2, max_df=0.95), ${pyStr(c)}),`),
    '])',
    `model = Pipeline([("pre", pre), ("model", ${m.expr})])`,
    'model.fit(X_train, y_train)',
    'pred = model.predict(X_test)',
  );
  if (task === 'classification') out.push('print("accuracy", accuracy_score(y_test, pred))', 'print("macro F1", f1_score(y_test, pred, average="macro"))', 'print(classification_report(y_test, pred))');
  else out.push('print("MAE", mean_absolute_error(y_test, pred))', 'print("RMSE", mean_squared_error(y_test, pred) ** 0.5)', 'print("R2", r2_score(y_test, pred))');
  return out.join('\n') + '\n';
}
