import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import { ObsAudioDevice } from 'main/obsAudioDeviceUtils';
import Box from '@mui/material/Box';
import InfoIcon from '@mui/icons-material/Info';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { ISettingsPanelProps } from 'main/types';
import { configSchema } from '../main/configSchema';

const ipc = window.electron.ipcRenderer;

export default function GeneralSettings(props: ISettingsPanelProps) {
  const { config, onChange } = props;
  const audioDevices = ipc.sendSync('getAudioDevices', []);

  const availableAudioDevices = {
    input: [
      // @@@ TODO plumb these through
      // {
      //   id: 'none',
      //   description: 'None (no input audio devices will be recorded)',
      // },
      // {
      //   id: 'all',
      //   description: 'All (all input audio devices will be recorded)',
      // },
      ...audioDevices.input,
    ],
    output: [
      // @@@ TODO plumb these through
      // {
      //   id: 'none',
      //   description: 'None (no output audio devices will be recorded)',
      // },
      // {
      //   id: 'all',
      //   description: 'All (all output audio devices will be recorded)',
      // },
      ...audioDevices.output,
    ],
  };

  const style = {
    width: '405px',
    color: 'white',
    '& .MuiOutlinedInput-notchedOutline': {
      borderColor: 'black',
    },
    '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
      borderColor: '#bb4220',
    },
    '&.Mui-focused': {
      borderColor: '#bb4220',
      color: '#bb4220',
    },
  };

  return (
    <Stack
      component="form"
      sx={{
        '& > :not(style)': { m: 0, width: '50ch' },
      }}
      noValidate
      autoComplete="off"
    >
      <Box component="span" sx={{ display: 'flex', alignItems: 'center' }}>
        <FormControl sx={{ my: 1 }}>
          <InputLabel id="demo-simple-select-label" sx={style}>
            Input
          </InputLabel>
          <Select
            name="audioInputDevice"
            labelId="demo-simple-select-label"
            id="audio-input-device"
            value={config.audioInputDevice}
            label="Input"
            onChange={onChange}
            sx={style}
          >
            {availableAudioDevices.input.map((device: ObsAudioDevice) => { // @@@ fix types
              return (
                <MenuItem key={`device_${device.id}`} value={device.id}>
                  {device.description}
                </MenuItem>
              );
            })}
          </Select>
        </FormControl>
        <Tooltip title={configSchema.audioInputDevice.description}>
          <IconButton>
            <InfoIcon style={{ color: 'white' }} />
          </IconButton>
        </Tooltip>
      </Box>
      <Box component="span" sx={{ display: 'flex', alignItems: 'center' }}>
        <FormControl sx={{ my: 1 }}>
          <InputLabel id="demo-simple-select-label" sx={style}>
            Output
          </InputLabel>
          <Select
            name="audioOutputDevice"
            labelId="demo-simple-select-label"
            id="audio-output-device"
            value={config.audioOutputDevice}
            label="Output"
            onChange={onChange}
            sx={style}
          >
            {availableAudioDevices.output.map((device: ObsAudioDevice) => { // @@@ fix types
              return (
                <MenuItem key={`device_${device.id}`} value={device.id}>
                  {device.description}
                </MenuItem>
              );
            })}
          </Select>
        </FormControl>
        <Tooltip title={configSchema.audioOutputDevice.description}>
          <IconButton>
            <InfoIcon style={{ color: 'white' }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Stack>
  );
}
