import {
  PersonalTaskRejectedError,
  validatePersonalTime,
  type PersonalTaskChange,
  type WorkTask,
} from "@praxis/application";
export function personalInlineEdit(
  task: WorkTask,
  draft: { title: string; notes: string; date: string; editDeadline: boolean },
): Extract<PersonalTaskChange, { type: "edit" }> {
  const change: Extract<PersonalTaskChange, { type: "edit" }> = {
    type: "edit",
  };
  const title = draft.title.trim();
  if (!title) throw new PersonalTaskRejectedError("请填写任务标题");
  if (title !== task.title) {
    if ([...title].length > 500)
      throw new PersonalTaskRejectedError("任务标题最多500个字符");
    change.title = title;
  }
  if (draft.notes !== task.notes) change.notes = draft.notes;
  if (draft.notes.length > 100000)
    throw new PersonalTaskRejectedError("任务说明过长");
  if (draft.editDeadline) {
    change.deadline = draft.date ? { kind: "date", date: draft.date } : null;
    try {
      validatePersonalTime(change.deadline);
    } catch (error) {
      throw new PersonalTaskRejectedError(error);
    }
  }
  return change;
}
