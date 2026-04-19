import { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  FolderKanban,
  Plus,
  ArrowLeft,
  FileText,
  Upload,
  Trash2,
  Save,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { uid } from '@/lib/utils';
import type { ProjectSource } from '@/types';

export default function ProjectsView() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const projects = useAppStore((s) => s.projects);
  const createProject = useAppStore((s) => s.createProject);
  const conversations = useAppStore((s) => s.conversations);

  const [showDialog, setShowDialog] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const activeProject = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId]
  );

  const onCreate = () => {
    if (!newName.trim()) return;
    const id = createProject(newName.trim(), newDesc.trim() || undefined);
    setNewName('');
    setNewDesc('');
    setShowDialog(false);
    navigate(`/projects/${id}`);
  };

  if (activeProject) {
    return <ProjectDetail projectId={activeProject.id} />;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold">项目 Projects</h1>
            <p className="text-sm text-claude-muted dark:text-night-muted mt-1">
              把相关对话、文件、自定义指令组织在一起。
            </p>
          </div>
          <button onClick={() => setShowDialog(true)} className="btn-primary">
            <Plus className="w-4 h-4" />
            新项目
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="text-center py-20 border border-dashed border-claude-border dark:border-night-border rounded-xl">
            <FolderKanban className="w-8 h-8 mx-auto mb-3 text-claude-muted dark:text-night-muted" />
            <div className="font-medium">还没有项目</div>
            <p className="text-sm text-claude-muted dark:text-night-muted mt-1">
              创建项目来沉淀知识库、挂载文件、自定义系统提示。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {projects.map((p) => {
              const convCount = conversations.filter((c) => c.projectId === p.id).length;
              return (
                <button
                  key={p.id}
                  onClick={() => navigate(`/projects/${p.id}`)}
                  className="text-left p-4 rounded-xl border border-claude-border dark:border-night-border hover:border-claude-accent transition bg-claude-surface dark:bg-night-surface"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium truncate">{p.name}</div>
                    <span className="text-xs text-claude-muted dark:text-night-muted shrink-0">
                      {convCount} 对话
                    </span>
                  </div>
                  <div className="text-sm text-claude-muted dark:text-night-muted mt-1 line-clamp-2">
                    {p.description ?? '无描述'}
                  </div>
                  <div className="text-xs text-claude-muted dark:text-night-muted mt-2">
                    {p.sources.length} 个知识源
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {showDialog && (
          <div
            className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 animate-fade-in"
            onClick={() => setShowDialog(false)}
          >
            <div
              className="w-full max-w-md rounded-2xl bg-claude-bg dark:bg-night-bg border border-claude-border dark:border-night-border p-5 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-lg font-semibold mb-4">新建项目</h2>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-claude-muted dark:text-night-muted">
                    项目名称
                  </label>
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="例如：飞书接入"
                    className="w-full mt-1 px-3 py-2 rounded-md bg-transparent border border-claude-border dark:border-night-border focus:outline-none focus:border-claude-accent text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-claude-muted dark:text-night-muted">
                    描述（可选）
                  </label>
                  <textarea
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    rows={3}
                    placeholder="这个项目是关于什么的？"
                    className="w-full mt-1 px-3 py-2 rounded-md bg-transparent border border-claude-border dark:border-night-border focus:outline-none focus:border-claude-accent text-sm resize-none"
                  />
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setShowDialog(false)} className="btn-ghost">
                  取消
                </button>
                <button onClick={onCreate} className="btn-primary">
                  创建
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectDetail({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const project = useAppStore((s) => s.projects.find((p) => p.id === projectId));
  const updateProject = useAppStore((s) => s.updateProject);
  const deleteProject = useAppStore((s) => s.deleteProject);
  const addProjectSource = useAppStore((s) => s.addProjectSource);
  const removeProjectSource = useAppStore((s) => s.removeProjectSource);
  const conversations = useAppStore((s) => s.conversations);
  const newConversation = useAppStore((s) => s.newConversation);
  const setConversationProject = useAppStore((s) => s.setConversationProject);

  const [instrDraft, setInstrDraft] = useState(project?.instructions ?? '');
  const [instrSaved, setInstrSaved] = useState(true);

  if (!project) return null;

  const projectConversations = conversations.filter((c) => c.projectId === project.id);

  const saveInstructions = () => {
    updateProject(project.id, { instructions: instrDraft });
    setInstrSaved(true);
  };

  const onUpload = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const text = await readFileAsText(f);
      const src: ProjectSource = {
        id: uid('src'),
        kind: 'file',
        name: f.name,
        content: text,
        tokenEstimate: Math.ceil(text.length / 4),
      };
      addProjectSource(project.id, src);
    }
  };

  const startNewChat = () => {
    const id = newConversation('chat', project.id);
    setConversationProject(id, project.id);
    navigate(`/chat/${id}`);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <button
          onClick={() => navigate('/projects')}
          className="btn-ghost mb-4 -ml-2"
        >
          <ArrowLeft className="w-4 h-4" />
          返回项目列表
        </button>

        <div className="flex items-start justify-between mb-6 gap-4">
          <div className="flex-1 min-w-0">
            <input
              value={project.name}
              onChange={(e) => updateProject(project.id, { name: e.target.value })}
              className="text-2xl font-semibold bg-transparent border-0 focus:outline-none w-full"
            />
            <input
              value={project.description ?? ''}
              onChange={(e) => updateProject(project.id, { description: e.target.value })}
              placeholder="添加描述..."
              className="mt-1 text-sm text-claude-muted dark:text-night-muted bg-transparent border-0 focus:outline-none w-full"
            />
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={startNewChat} className="btn-primary">
              <Plus className="w-4 h-4" />
              在此项目中对话
            </button>
            <button
              onClick={() => {
                if (confirm(`删除项目「${project.name}」？\n项目下的对话会保留但会取消关联。`)) {
                  deleteProject(project.id);
                  navigate('/projects');
                }
              }}
              className="btn-ghost text-red-500"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Custom instructions */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-semibold">项目指令 (System Prompt)</h2>
            <button
              onClick={saveInstructions}
              disabled={instrSaved}
              className="btn-primary disabled:opacity-40"
            >
              <Save className="w-3.5 h-3.5" />
              {instrSaved ? '已保存' : '保存'}
            </button>
          </div>
          <p className="text-xs text-claude-muted dark:text-night-muted mb-2">
            为这个项目设定风格、身份、规则。所有在此项目下的对话会自动加载。
          </p>
          <textarea
            value={instrDraft}
            onChange={(e) => {
              setInstrDraft(e.target.value);
              setInstrSaved(false);
            }}
            rows={8}
            placeholder={`例如：\n你是我的 TypeScript 高级顾问。\n- 回答简短精炼\n- 只在必要时展示代码\n- 优先推荐类型安全方案`}
            className="w-full px-3 py-2 text-sm rounded-lg bg-transparent border border-claude-border dark:border-night-border focus:outline-none focus:border-claude-accent font-mono resize-y min-h-[140px]"
          />
        </section>

        {/* Knowledge sources */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-semibold">知识源</h2>
            <label className="btn-primary cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              上传文件
              <input
                type="file"
                multiple
                className="hidden"
                accept=".txt,.md,.json,.csv,.log,.py,.js,.ts,.tsx,.jsx,.html,.css,.yml,.yaml,.xml"
                onChange={(e) => onUpload(e.target.files)}
              />
            </label>
          </div>
          <p className="text-xs text-claude-muted dark:text-night-muted mb-2">
            上传的文件会作为上下文注入对话（目前为文本全文注入，后续将接入向量检索）。
          </p>

          {project.sources.length === 0 ? (
            <div className="text-center py-10 border border-dashed border-claude-border dark:border-night-border rounded-xl text-sm text-claude-muted dark:text-night-muted">
              还没有文件。上传 .md / .txt / 代码文件作为项目背景。
            </div>
          ) : (
            <div className="space-y-1">
              {project.sources.map((src) => (
                <div
                  key={src.id}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-claude-border dark:border-night-border hover:border-claude-accent transition"
                >
                  <FileText className="w-4 h-4 text-claude-muted dark:text-night-muted" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{src.name}</div>
                    <div className="text-xs text-claude-muted dark:text-night-muted">
                      {src.kind} · ~{src.tokenEstimate ?? 0} tokens
                    </div>
                  </div>
                  <button
                    onClick={() => removeProjectSource(project.id, src.id)}
                    className="text-claude-muted hover:text-red-500 transition"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Conversations in project */}
        <section>
          <h2 className="text-lg font-semibold mb-2">项目对话</h2>
          {projectConversations.length === 0 ? (
            <div className="text-sm text-claude-muted dark:text-night-muted">
              这个项目下还没有对话。
            </div>
          ) : (
            <div className="space-y-1">
              {projectConversations.map((c) => (
                <button
                  key={c.id}
                  onClick={() => navigate(`/${c.mode}/${c.id}`)}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition"
                >
                  <div className="text-sm truncate">{c.title}</div>
                  <div className="text-xs text-claude-muted dark:text-night-muted">
                    {c.mode} · {c.messages.length} 条消息
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
