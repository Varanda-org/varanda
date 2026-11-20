// Explainer for a member who already linked an account, before the Brazilian
// mobile check. The caller remembers the acknowledgement for this launch
// only: this screen never records it, so nothing is written on the device
// and the next launch asks again. The delete button starts deletion in the
// app (App Store 5.1.1(v)); this screen only calls onDelete.

import { CONTINUE_LABEL, DELETE_LABEL, EXPLAINER } from '../phoneExplainer'
import { Body, Btn, Page } from '../ui'
import { Stepper } from '../ui/Stepper'

export default function TelefoneAviso ({ onContinue, onDelete }) {
  return (
    <Page flush grow padBottom={16}>
      <Stepper
        title={EXPLAINER.title}
        icon='smartphone'
        actions={[
          <Btn key='continue' label={CONTINUE_LABEL} onPress={onContinue} block large />,
          <Btn key='delete' label={DELETE_LABEL} secondary onPress={onDelete} block large />
        ]}
      >
        {EXPLAINER.points.map((point) => <Body key={point}>{point}</Body>)}
      </Stepper>
    </Page>
  )
}
