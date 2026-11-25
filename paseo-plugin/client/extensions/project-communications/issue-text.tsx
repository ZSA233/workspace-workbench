import { Fragment } from 'react';
import { Text, View } from 'react-native';
import type { TopicsClient } from '../../use-topics';
import type { IssueDetail, IssueInlineImage, IssueSelection } from '../../../shared/extensions/project-communications/issues';
import { issueAssets, issueAssetSelectable, issueTextParts, type IssueAsset } from '../../../shared/extensions/project-communications/issue-assets';
import { TopicAsset, TopicAssetGrid, topicTypography } from './topic-ui';
import { useColors } from './ui';

/** Text placement is source-specific; originals retain the shared preview and selection controls. */
export function IssueText({ id, client, issue, text, images, selection, disabled, onAsset }: {
  id: string; client: TopicsClient; issue: IssueDetail; text: string; images: IssueInlineImage[];
  selection?: IssueSelection; disabled: boolean; onAsset(asset: IssueAsset): void;
}) {
  const c = useColors(), assets = new Map(issueAssets(issue).map(asset => [asset.id, asset]));
  return <View testID={id} style={{ gap: 6 }}>
    {issueTextParts(text, images).map((part, index) => <Fragment key={index}>
      {part.text ? <Text selectable style={[topicTypography.body, { color: c.foreground }]}>{part.text}</Text> : null}
      {part.images.length ? <TopicAssetGrid inset={false}>
        {part.images.map((image, position) => {
          const asset = assets.get(image.id);
          return asset ? <TopicAsset key={image.id + ':' + position} {...{ client, issue, asset }}
            checked={Boolean(selection?.attachments.some(item => item.id === asset.id && item.version === asset.version))}
            disabled={disabled || !issueAssetSelectable(issue, asset)} onToggle={() => onAsset(asset)} /> : null;
        })}
      </TopicAssetGrid> : null}
    </Fragment>)}
  </View>;
}
