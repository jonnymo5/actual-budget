import React from 'react';
import type { ComponentType, CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import {
  SvgCalendar3,
  SvgCheckCircle1,
  SvgLockClosed,
} from '@actual-app/components/icons/v2';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { StatusBadge } from '#components/schedules/StatusBadge';

import type { VestStatus } from './useRsuData';

type VestStatusBadgeProps = {
  status: VestStatus | undefined;
};

export function VestStatusBadge({ status }: VestStatusBadgeProps) {
  const { t } = useTranslation();

  switch (status) {
    case 'recorded':
      return (
        <Pill
          text={t('Recorded')}
          color={theme.noticeText}
          backgroundColor={theme.noticeBackgroundLight}
          Icon={SvgCheckCircle1}
        />
      );
    case 'past':
      return (
        <Pill
          text={t('Past')}
          color={theme.buttonNormalDisabledText}
          backgroundColor={theme.tableRowHeaderBackground}
          Icon={SvgLockClosed}
        />
      );
    case 'needs-price':
      return (
        <Pill
          text={t('Needs price')}
          color={theme.warningTextDark}
          backgroundColor={theme.warningBackground}
          Icon={SvgCalendar3}
        />
      );
    case 'pending':
      return (
        <Pill
          text={t('Pending')}
          color={theme.upcomingText}
          backgroundColor={theme.upcomingBackground}
          Icon={SvgCalendar3}
        />
      );
    case undefined:
      return null;
    default:
      return <StatusBadge status={status} />;
  }
}

function Pill({
  text,
  color,
  backgroundColor,
  Icon,
}: {
  text: string;
  color: string;
  backgroundColor: string;
  Icon: ComponentType<{ style?: CSSProperties }>;
}) {
  return (
    <View
      style={{
        color,
        backgroundColor,
        padding: '6px 8px',
        borderRadius: 4,
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      <Icon
        style={{ width: 13, height: 13, color: 'inherit', marginRight: 7 }}
      />
      <Text style={{ lineHeight: '1em' }}>{text}</Text>
    </View>
  );
}
